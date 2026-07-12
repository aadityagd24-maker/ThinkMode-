import { json, platformError, requireUser } from '../../../../lib/blockoff/server.js';

function expectedOutputFromAction(action) {
  if (['hide', 'delete', 'blockoff'].includes(action)) return 'bad';
  if (['allow', 'restore'].includes(action)) return 'safe';
  return 'uncertain';
}

function fineTuneExample(row) {
  const meta = row.metadata || {};
  const snapshot = meta.comment_snapshot || {};
  const prediction = meta.model_prediction || {};
  return {
    messages: [
      {
        role: 'system',
        content: [
          'Classify social media comments for a creator moderation tool.',
          'Return JSON with: label, category, recommended_action, confidence, reason.',
          'Labels: bad, safe, uncertain.',
          'Categories: scam, abuse, brand_harm, creator_harm, sarcasm_harm, criticism, safe.',
          'Do not mark constructive criticism as bad unless it contains abuse, scam, or reputation manipulation.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          platform: row.platform,
          comment: snapshot.text || '',
          author: snapshot.author_name || '',
          likes: snapshot.like_count || 0,
          replies: snapshot.reply_count || 0,
          rule_prediction: prediction,
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          label: expectedOutputFromAction(row.action),
          category: prediction.category || 'uncertain',
          recommended_action: row.action,
          confidence: row.action === 'keep_review' ? 0.45 : 0.9,
          reason: prediction.reason || `Creator chose ${row.action}.`,
        }),
      },
    ],
  };
}

function labelTableExample(row) {
  return {
    messages: [
      {
        role: 'system',
        content: 'Classify social media comments for a creator moderation tool. Return JSON with label, category, recommended_action, confidence, reason.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          platform: row.platform,
          comment: row.comment_text,
          previous_prediction: row.model_prediction || {},
          reviewer_metadata: row.reviewer_metadata || {},
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          label: row.label?.startsWith('safe') ? 'safe' : row.label?.startsWith('bad') ? 'bad' : 'uncertain',
          category: row.category || 'uncertain',
          recommended_action: row.reviewer_metadata?.action || 'review',
          confidence: row.label?.startsWith('uncertain') ? 0.45 : 0.9,
          reason: `Human moderation label: ${row.label}`,
        }),
      },
    ],
  };
}

export async function GET({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const url = new URL(request.url);
    const format = url.searchParams.get('format') || 'json';

    const { data: labels, error: labelsError } = await supabase
      .from('comment_training_labels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (!labelsError && labels?.length) {
      const examples = labels.map(labelTableExample);
      if (format === 'jsonl') {
        return new Response(examples.map((item) => JSON.stringify(item)).join('\n'), {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': 'attachment; filename="blockoff-training.jsonl"',
          },
        });
      }
      return json({ ok: true, count: examples.length, source: 'comment_training_labels', examples });
    }

    const { data, error } = await supabase
      .from('moderation_actions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;

    const examples = (data || [])
      .filter((row) => row.metadata?.comment_snapshot?.text)
      .map(fineTuneExample);

    if (format === 'jsonl') {
      return new Response(examples.map((item) => JSON.stringify(item)).join('\n'), {
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-disposition': 'attachment; filename="blockoff-training.jsonl"',
        },
      });
    }

    return json({ ok: true, count: examples.length, examples });
  } catch (error) {
    return platformError(error);
  }
}
