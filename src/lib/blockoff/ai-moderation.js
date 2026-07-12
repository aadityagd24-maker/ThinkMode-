import { serverEnv } from './server.js';

const validLabels = new Set(['bad', 'safe', 'uncertain']);
const highRiskCategories = new Set(['scam', 'abuse', 'brand_harm', 'creator_harm', 'sarcasm_harm']);

function mergeScore(localScore, ai) {
  if (!ai || !validLabels.has(ai.label)) return localScore;
  const confidence = Number(ai.confidence || 0);
  if (ai.label === 'safe' && confidence >= 0.78) {
    return { ...localScore, priority_score: Math.min(localScore.priority_score, 24), category: ai.category === 'criticism' ? 'clean' : localScore.category, recommended_action: 'allow', reason: `${localScore.reason} | AI review: ${ai.reason || 'safe/constructive'}`, ai_review: ai };
  }
  if (ai.label === 'bad' && confidence >= 0.6) {
    const severe = highRiskCategories.has(ai.category);
    const priority = Math.max(severe ? 48 : 38, Number(localScore.priority_score || 0) + (ai.category === 'sarcasm_harm' || ai.category === 'brand_harm' ? 24 : 16));
    return { ...localScore, priority_score: Math.min(100, priority), category: ['brand_harm', 'sarcasm_harm'].includes(ai.category) ? 'brand' : ai.category === 'creator_harm' ? 'abuse' : (localScore.category === 'clean' ? 'review' : localScore.category), recommended_action: confidence >= 0.9 && priority >= 88 ? 'hide' : 'review', reason: `${localScore.reason} | AI review: ${ai.reason || ai.category}`, ai_review: ai };
  }
  const shouldReview = ai.label === 'uncertain' && (Number(localScore.priority_score || 0) >= 15 || confidence >= 0.65);
  return { ...localScore, priority_score: shouldReview ? Math.max(35, localScore.priority_score) : localScore.priority_score, category: shouldReview && localScore.category === 'clean' ? 'review' : localScore.category, recommended_action: shouldReview ? 'review' : localScore.recommended_action, reason: `${localScore.reason} | AI review: uncertain`, ai_review: ai };
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

function normalizeAi(result) {
  const rawLabel = String(result?.label || '').toLowerCase();
  const rawCategory = String(result?.category || '').toLowerCase().replaceAll(' ', '_');
  let label = rawLabel;
  if (['offensive', 'harmful', 'toxic', 'hate', 'harassment', 'spam'].includes(rawLabel)) label = 'bad';
  if (['benign', 'constructive', 'non-toxic', 'not_toxic'].includes(rawLabel)) label = 'safe';
  let category = rawCategory;
  if (['hate_speech', 'harassment', 'offensive', 'toxic'].includes(rawCategory)) category = 'abuse';
  if (['mockery', 'sarcasm', 'sarcastic'].includes(rawCategory)) category = 'sarcasm_harm';
  if (!['scam', 'abuse', 'brand_harm', 'creator_harm', 'sarcasm_harm', 'criticism', 'safe'].includes(category)) category = label === 'bad' ? 'creator_harm' : label === 'safe' ? 'safe' : 'criticism';
  return { ...result, label, category, confidence: Number(result?.confidence || 0) };
}

async function classifyBatch(items, context, model) {
  const apiKey = serverEnv('OPENAI_API_KEY');
  const baseUrl = (serverEnv('BLOCKOFF_AI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Math.max(350, items.length * 90),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You classify social media comments for creator and brand safety. Detect insults, dismissive mockery, sarcasm, dog whistles, reputation attacks, scams, threats, and harassment. Protect respectful disagreement and constructive criticism. Return JSON only as {"results":[{"id":string,"label":"bad|safe|uncertain","category":"scam|abuse|brand_harm|creator_harm|sarcasm_harm|criticism|safe","recommended_action":"allow|review|hide|blockoff|delete","confidence":number,"reason":string}]}. Return exactly one result per input id.' },
        { role: 'user', content: JSON.stringify({ creator_context: { keywords: context.keywords || [] }, comments: items.map(({ comment, localScore }, index) => ({ id: String(index), text: comment.text || '', author: comment.author_name || '', likes: comment.like_count || comment.likeCount || 0, replies: comment.reply_count || comment.replyCount || 0, local_category: localScore.category, local_priority: localScore.priority_score })) }) },
      ],
    }),
  });
  if (!response.ok) return { results: [], error: `AI provider returned ${response.status}` };
  const payload = await response.json();
  const parsed = extractJson(payload.choices?.[0]?.message?.content);
  return { results: Array.isArray(parsed?.results) ? parsed.results : [], model: payload.model || model };
}

function needsCheapReview(score) {
  return Number(score.priority_score || 0) < 75 && score.recommended_action !== 'hide';
}

export async function reviewCommentBatch(entries, context = {}, remaining = 0) {
  const apiKey = serverEnv('OPENAI_API_KEY');
  if (!apiKey || remaining <= 0) return { scores: entries.map((entry) => entry.localScore), reviewed: 0 };
  const candidates = entries.map((entry, index) => ({ ...entry, originalIndex: index })).filter((entry) => needsCheapReview(entry.localScore)).slice(0, Math.min(20, remaining));
  if (!candidates.length) return { scores: entries.map((entry) => entry.localScore), reviewed: 0 };

  const primaryModel = serverEnv('BLOCKOFF_AI_MODEL') || 'amazon/nova-micro-v1';
  const primary = await classifyBatch(candidates, context, primaryModel);
  const byId = new Map(primary.results.map(normalizeAi).map((result) => [String(result.id), result]));
  const merged = entries.map((entry) => entry.localScore);
  const fallbackCandidates = [];
  candidates.forEach((entry, batchIndex) => {
    const ai = byId.get(String(batchIndex));
    if (!ai) return;
    merged[entry.originalIndex] = mergeScore(entry.localScore, ai);
    const disagreement = ai.label === 'uncertain' || (ai.label === 'safe' && Number(entry.localScore.priority_score || 0) >= 35);
    const visible = Number(entry.comment.like_count || 0) + Number(entry.comment.reply_count || 0) >= 5;
    if (disagreement && (visible || Number(entry.localScore.priority_score || 0) >= 20)) fallbackCandidates.push(entry);
  });

  let fallbackReviewed = 0;
  if (fallbackCandidates.length) {
    const fallbackModel = serverEnv('BLOCKOFF_AI_FALLBACK_MODEL') || 'openai/gpt-4o-mini';
    const fallback = await classifyBatch(fallbackCandidates.slice(0, 5), context, fallbackModel);
    const fallbackById = new Map(fallback.results.map(normalizeAi).map((result) => [String(result.id), result]));
    fallbackCandidates.slice(0, 5).forEach((entry, index) => {
      const ai = fallbackById.get(String(index));
      if (ai) { merged[entry.originalIndex] = mergeScore(entry.localScore, ai); fallbackReviewed += 1; }
    });
  }
  return { scores: merged, reviewed: primary.results.length, fallbackReviewed, model: primary.model || primaryModel, error: primary.error || null };
}
