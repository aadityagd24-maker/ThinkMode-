import { deleteInstagramComment, getInstagramAccessToken, hideInstagramComment } from '../../../../lib/blockoff/instagram.js';
import { moderateYoutubeComments, refreshYoutubeToken } from '../../../../lib/blockoff/youtube.js';
import { badRequest, json, logActivity, platformError, requireUser } from '../../../../lib/blockoff/server.js';

function labelFromAction(action) {
  return {
    hide: 'bad_hide',
    delete: 'bad_delete',
    blockoff: 'bad_block_author',
    allow: 'safe_allow',
    restore: 'safe_restore',
    keep_review: 'uncertain_review',
  }[action] || 'uncertain_review';
}

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const body = await request.json().catch(() => null);
    if (!body) return badRequest('Invalid action request.');

    const ids = Array.isArray(body.comment_ids) ? [...new Set(body.comment_ids)].slice(0, 50) : [];
    const action = ['hide', 'delete', 'blockoff', 'allow', 'restore', 'keep_review'].includes(body.action)
      ? body.action
      : 'keep_review';

    if (!ids.length) return badRequest('Choose at least one comment.');

    const { data: comments, error } = await supabase
      .from('comments')
      .select('*,connected_accounts(*)')
      .eq('user_id', user.id)
      .in('id', ids);

    if (error) throw error;
    if (!comments?.length) return badRequest('No matching comments found.');
    if (comments.length !== ids.length) return badRequest('One or more comments are unavailable.');

    const nextStatus = {
      hide: 'hidden',
      delete: 'deleted',
      blockoff: 'blocked',
      allow: 'allowed',
      restore: 'restored',
      keep_review: 'needs_review',
    }[action];
    const pendingComments = comments.filter((comment) => comment.status !== nextStatus);
    if (!pendingComments.length) return json({ ok: true, status: nextStatus, count: 0, already_applied: true });

    const byPlatform = pendingComments.reduce((groups, comment) => {
      groups[comment.platform] ||= [];
      groups[comment.platform].push(comment);
      return groups;
    }, {});

    for (const [platform, group] of Object.entries(byPlatform)) {
      const account = group[0].connected_accounts;
      if (!account || account.status !== 'active') {
        return badRequest(`Reconnect ${platform} before moderating comments.`);
      }

      if (platform === 'youtube' && action === 'delete') {
        return badRequest('YouTube channel owners cannot delete comments written by other users. Use Hide or Block OFF.');
      }
      if (platform === 'instagram' && action === 'blockoff') {
        return badRequest('Instagram does not expose an author-ban action. Use Hide or Delete.');
      }

      if (platform === 'youtube' && ['hide', 'blockoff', 'restore', 'allow'].includes(action)) {
        const token = await refreshYoutubeToken(supabase, account);
        await moderateYoutubeComments(token, group.map((comment) => comment.external_id), action);
        await supabase.from('quota_usage').insert({
          user_id: user.id,
          platform,
          date: new Date().toISOString().slice(0, 10),
          operation: action,
          units_used: 50,
          details: { batch_size: group.length },
        });
      }

      if (platform === 'instagram' && ['hide', 'restore', 'allow'].includes(action)) {
        const token = await getInstagramAccessToken(supabase, account);
        for (const comment of group) {
          await hideInstagramComment(token, comment.external_id, action !== 'restore' && action !== 'allow');
        }
      }

      if (platform === 'instagram' && action === 'delete') {
        const token = await getInstagramAccessToken(supabase, account);
        for (const comment of group) {
          await deleteInstagramComment(token, comment.external_id);
        }
      }
    }

    await supabase
      .from('comments')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .in('id', ids);

    const actionRows = pendingComments.map((comment) => ({
      user_id: user.id,
      connected_account_id: comment.connected_account_id,
      comment_id: comment.id,
      platform: comment.platform,
      action,
      status: 'completed',
      metadata: {
        external_id: comment.external_id,
        training_label: labelFromAction(action),
        model_prediction: {
          category: comment.category,
          recommended_action: comment.recommended_action,
          severity_score: comment.severity_score,
          engagement_score: comment.engagement_score,
          brand_risk_score: comment.brand_risk_score,
          creator_risk_score: comment.creator_risk_score,
          priority_score: comment.priority_score,
          reason: comment.reason,
        },
        comment_snapshot: {
          text: comment.text,
          author_name: comment.author_name,
          like_count: comment.like_count,
          reply_count: comment.reply_count,
          published_at: comment.published_at,
        },
      },
    }));

    const { data: insertedActions } = await supabase
      .from('moderation_actions')
      .insert(actionRows)
      .select('*');

    if (insertedActions?.length) {
      const labelRows = insertedActions.map((row) => {
        const meta = row.metadata || {};
        return {
          user_id: user.id,
          comment_id: row.comment_id,
          moderation_action_id: row.id,
          platform: row.platform,
          label: meta.training_label,
          category: meta.model_prediction?.category || null,
          comment_text: meta.comment_snapshot?.text || '',
          model_version: meta.model_prediction?.model_version || 'rules-v2-semantic-harm',
          model_prediction: meta.model_prediction || {},
          reviewer_metadata: {
            action: row.action,
            author_name: meta.comment_snapshot?.author_name,
            like_count: meta.comment_snapshot?.like_count,
            reply_count: meta.comment_snapshot?.reply_count,
          },
        };
      });
      const { error: labelError } = await supabase.from('comment_training_labels').insert(labelRows);
      // Learning data is optional and must not turn a completed platform action into a UI failure.
      if (labelError && !['42P01', 'PGRST205'].includes(labelError.code)) {
        console.warn('Training label write skipped:', labelError.message || labelError.code);
      }
    }

    await logActivity(supabase, user.id, `Comment action: ${action}`, `${pendingComments.length} comment${pendingComments.length === 1 ? '' : 's'} updated`);

    return json({ ok: true, status: nextStatus, count: pendingComments.length });
  } catch (error) {
    return platformError(error);
  }
}
