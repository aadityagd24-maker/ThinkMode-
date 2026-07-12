import { demoComments } from '../../../lib/blockoff/moderation.js';
import { getInstagramAccessToken, getInstagramComments } from '../../../lib/blockoff/instagram.js';
import { reviewCommentBatch } from '../../../lib/blockoff/ai-moderation.js';
import { scoreComment } from '../../../lib/blockoff/moderation.js';
import { YoutubeApiError, getYoutubeComments, refreshYoutubeToken } from '../../../lib/blockoff/youtube.js';
import { badRequest, json, logActivity, platformError, requireUser, serverEnv } from '../../../lib/blockoff/server.js';

async function getModerationContext(supabase, userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('brand_names,sensitive_keywords')
    .eq('id', userId)
    .maybeSingle();

  const { data: rules } = await supabase
    .from('rules')
    .select('type,value,enabled')
    .eq('user_id', userId)
    .in('type', ['keyword', 'system']);

  const keywords = [
    ...(profile?.brand_names || []),
    ...(profile?.sensitive_keywords || []),
    ...(rules || []).filter((rule) => rule.type === 'keyword' && rule.enabled).map((rule) => rule.value),
  ].map((item) => String(item).toLowerCase());

  const settings = Object.fromEntries(
    (rules || [])
      .filter((rule) => rule.type === 'system')
      .map((rule) => [rule.value, Boolean(rule.enabled)]),
  );

  return { keywords, settings };
}

async function aiBudgetRemaining(supabase, userId) {
  const cap = Number(serverEnv('BLOCKOFF_AI_DAILY_CAP') || 0);
  if (!cap || !serverEnv('OPENAI_API_KEY')) return 0;
  const { data } = await supabase
    .from('quota_usage')
    .select('units_used')
    .eq('user_id', userId)
    .eq('platform', 'ai')
    .eq('date', new Date().toISOString().slice(0, 10));
  const used = (data || []).reduce((sum, row) => sum + Number(row.units_used || 0), 0);
  return Math.max(0, cap - used);
}

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const body = await request.json().catch(() => null);
    if (!body) return badRequest('Invalid scan request.');

    const contentIds = Array.isArray(body.content_ids) ? [...new Set(body.content_ids)].slice(0, 5) : [];
    const previewOnly = Boolean(body.preview_only);
    const maxResults = previewOnly ? 10 : 75;

    if (!contentIds.length) return badRequest('Select at least one video or post.');

    const { data: contentItems, error: contentError } = await supabase
      .from('content_items')
      .select('*')
      .eq('user_id', user.id)
      .in('id', contentIds);

    if (contentError) throw contentError;
    if (!contentItems?.length) {
      const platform = body.platform === 'instagram' ? 'instagram' : 'youtube';
      return json({ ok: true, demo: true, comments: demoComments(platform), scanned: demoComments(platform).length });
    }

    const moderationContext = await getModerationContext(supabase, user.id);
    const allComments = [];
    const skipped = [];
    let aiRemaining = await aiBudgetRemaining(supabase, user.id);

    for (const item of contentItems) {
      const { data: account } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('user_id', user.id)
        .eq('platform', item.platform)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();

      if (!account) continue;

      let rawComments = [];
      if (item.platform === 'youtube') {
        const token = await refreshYoutubeToken(supabase, account);
        try {
          rawComments = await getYoutubeComments(token, item.external_id, maxResults);
        } catch (error) {
          if (error instanceof YoutubeApiError && error.reason === 'commentsDisabled') {
            skipped.push({ content_item_id: item.id, title: item.title, reason: 'comments_disabled' });
            await logActivity(supabase, user.id, 'YouTube comments unavailable', `${item.title || 'Selected video'} has comments disabled.`, 'youtube');
            continue;
          }
          throw error;
        }
      } else {
        const token = await getInstagramAccessToken(supabase, account);
        rawComments = await getInstagramComments(token, item.external_id, maxResults);
      }

      let aiUsedForItem = 0;
      let fallbackUsedForItem = 0;
      const rows = [];
      const localEntries = rawComments.map((comment) => ({ comment: { ...comment, platform: item.platform }, localScore: scoreComment(comment, moderationContext) }));
      const batchReview = await reviewCommentBatch(localEntries, moderationContext, aiRemaining);
      aiUsedForItem = batchReview.reviewed || 0;
      fallbackUsedForItem = batchReview.fallbackReviewed || 0;
      aiRemaining = Math.max(0, aiRemaining - aiUsedForItem - fallbackUsedForItem);
      for (let commentIndex = 0; commentIndex < rawComments.length; commentIndex += 1) {
        const comment = rawComments[commentIndex];
        const score = batchReview.scores[commentIndex] || localEntries[commentIndex].localScore;
        rows.push({
          user_id: user.id,
          connected_account_id: account.id,
          content_item_id: item.id,
          platform: item.platform,
          external_id: comment.external_id,
          author_name: comment.author_name,
          author_external_id: comment.author_channel_id,
          text: comment.text,
          status: score.priority_score >= 35 ? 'needs_review' : 'allowed',
          category: score.category,
          recommended_action: score.recommended_action,
          severity_score: score.severity_score,
          engagement_score: score.engagement_score,
          brand_risk_score: score.brand_risk_score,
          creator_risk_score: score.creator_risk_score,
          priority_score: score.priority_score,
          reason: score.reason,
          like_count: comment.like_count,
          reply_count: comment.reply_count,
          published_at: comment.published_at,
          metadata: {
            raw: comment.raw || {},
            model_version: score.ai_review ? 'rules-v2-plus-ai-uncertain' : 'rules-v2-semantic-harm',
            signal_evidence: score.signal_evidence || {},
            ai_review: score.ai_review || null,
          },
          updated_at: new Date().toISOString(),
        });
      }

      if (rows.length) {
        const { data, error } = await supabase
          .from('comments')
          .upsert(rows, { onConflict: 'user_id,platform,external_id' })
          .select('*');

        if (error) throw error;
        allComments.push(...(data || []));
      }

      await supabase.from('quota_usage').insert({
        user_id: user.id,
        platform: item.platform,
        date: new Date().toISOString().slice(0, 10),
        operation: previewOnly ? 'preview_scan' : 'scan',
        units_used: item.platform === 'youtube' ? 1 : 0,
        details: { content_item_id: item.id, maxResults },
      });

      if (aiUsedForItem) {
        await supabase.from('quota_usage').insert({
          user_id: user.id,
          platform: 'ai',
          date: new Date().toISOString().slice(0, 10),
          operation: 'uncertain_comment_ai_review',
          units_used: aiUsedForItem,
          details: { content_item_id: item.id, model: serverEnv('BLOCKOFF_AI_MODEL') || 'amazon/nova-micro-v1', fallback_model: serverEnv('BLOCKOFF_AI_FALLBACK_MODEL') || 'openai/gpt-4o-mini', fallback_reviews: fallbackUsedForItem },
        });
      }

      await supabase
        .from('content_items')
        .update({
          metadata: {
            ...(item.metadata || {}),
            blockoff_previous_comment_count: item.comment_count || 0,
            blockoff_last_scanned_at: new Date().toISOString(),
            blockoff_last_scan_mode: previewOnly ? 'preview' : 'full',
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('user_id', user.id);
    }

    const risky = allComments
      .filter((comment) => comment.status !== 'allowed')
      .sort((a, b) => b.priority_score - a.priority_score);

    await logActivity(supabase, user.id, previewOnly ? 'Preview scan completed' : 'Scan completed', `${allComments.length} comments checked, ${risky.length} need review`);

    return json({
      ok: true,
      comments: risky,
      preview_comments: allComments
        .sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0))
        .slice(0, 10),
      scanned: allComments.length,
      skipped,
    });
  } catch (error) {
    return platformError(error);
  }
}
