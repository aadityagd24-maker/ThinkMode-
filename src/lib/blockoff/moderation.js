const scamSignals = [
  'whatsapp',
  'telegram',
  'giveaway',
  'crypto',
  'bitcoin',
  'airdrop',
  'bit.ly',
  'free prize',
  'dm me',
  'investment',
];

const abuseSignals = [
  'delete your channel',
  'nobody asked',
  'clown',
  'idiot',
  'stupid',
  'hate you',
  'kill yourself',
  'worthless',
  'ugly',
  'noob',
  'get a job',
  'go do some work',
  'do some work',
  'touch grass',
];

const creatorImageSignals = [
  'sellout',
  'washed',
  'fallen off',
  'desperate',
  'attention seeker',
  'fake expert',
  'fraud creator',
  'only here for money',
  'lost all respect',
  'embarrassing',
  'cringe',
];

const sarcasmHarmSignals = [
  'nice scam',
  'great job scamming',
  'totally not sponsored',
  'sure buddy',
  'what a genius',
  'so honest',
  'definitely trustworthy',
  'not suspicious at all',
  'love being lied to',
  'another cash grab',
];

const brandRiskSignals = [
  'scam',
  'fraud',
  'fake',
  'shady',
  'refund',
  'sponsor',
  'paid promotion',
  'boycott',
  'ripoff',
  'do not buy',
  "don't buy",
  'waste of money',
  'stole my money',
  'untrustworthy',
  'data leak',
  'unsafe',
  'lawsuit',
  'chargeback',
  'cancelled my order',
];

const impersonationSignals = [
  'fake account',
  'impersonating',
  'pretending to be you',
  'replying as you',
  'telegram admin',
  'official support',
  'contact me on whatsapp',
  'claim your prize',
  'winner selected',
];

const constructiveSignals = [
  'can you explain',
  'why did you',
  'feedback',
  'suggestion',
  'confused',
  'not clear',
  'disagree',
];

function includesAny(text, signals) {
  return signals.filter((signal) => text.includes(signal));
}

export function scoreComment(comment, context = {}) {
  const rawText = comment.text || comment.textDisplay || comment.textOriginal || '';
  const text = rawText.toLowerCase();
  const settings = {
    scam_links: context.settings?.scam_links !== false,
    engagement_priority: context.settings?.engagement_priority !== false,
    constructive_shield: context.settings?.constructive_shield !== false,
    brand_risk: context.settings?.brand_risk !== false,
  };
  const scam = settings.scam_links ? includesAny(text, scamSignals) : [];
  const abuse = includesAny(text, abuseSignals);
  const creatorImage = includesAny(text, creatorImageSignals);
  const sarcasticHarm = includesAny(text, sarcasmHarmSignals);
  const brandRisk = settings.brand_risk ? includesAny(text, brandRiskSignals) : [];
  const impersonation = includesAny(text, impersonationSignals);
  const constructive = settings.constructive_shield ? includesAny(text, constructiveSignals) : [];
  const userKeywords = settings.brand_risk ? includesAny(text, context.keywords || []) : [];
  const likeCount = Number(comment.likeCount || comment.likes || comment.like_count || 0);
  const replyCount = Number(comment.replyCount || comment.replies || comment.reply_count || 0);
  const isTopComment = Boolean(comment.isTopComment);

  const scamScore = Math.min(95, scam.length * 23 + impersonation.length * 26 + (text.includes('http') ? 22 : 0));
  const abuseScore = Math.min(92, abuse.length * 22 + creatorImage.length * 14);
  const sarcasmScore = Math.min(82, sarcasticHarm.length * 24);
  const brandScore = Math.min(92, brandRisk.length * 20 + userKeywords.length * 18 + sarcasticHarm.length * 14);
  const constructiveShield = constructive.length && !scam.length && !impersonation.length && !sarcasticHarm.length ? 28 : 0;
  const severity = Math.max(scamScore, abuseScore, brandScore);
  const engagement = settings.engagement_priority
    ? Math.min(35, likeCount * 2 + replyCount * 3 + (isTopComment ? 12 : 0))
    : 0;
  const priority = Math.max(0, Math.min(100, severity + sarcasmScore + engagement - constructiveShield));

  let category = 'clean';
  if (scamScore >= 45) category = 'scam';
  else if (abuseScore >= 40) category = 'abuse';
  else if (brandScore >= 36 || sarcasmScore >= 45) category = 'brand';
  else if (priority >= 40) category = 'review';

  let recommendedAction = 'allow';
  if (priority >= 88 && constructiveShield === 0) recommendedAction = 'hide';
  else if (priority >= 35) recommendedAction = 'review';

  const reasonParts = [];
  if (scam.length) reasonParts.push(`Scam signals: ${scam.join(', ')}`);
  if (impersonation.length) reasonParts.push(`Impersonation signals: ${impersonation.join(', ')}`);
  if (abuse.length) reasonParts.push(`Abuse signals: ${abuse.join(', ')}`);
  if (creatorImage.length) reasonParts.push(`Creator image risk: ${creatorImage.join(', ')}`);
  if (sarcasticHarm.length) reasonParts.push(`Sarcastic reputation harm: ${sarcasticHarm.join(', ')}`);
  if (brandRisk.length || userKeywords.length) reasonParts.push(`Brand risk: ${[...brandRisk, ...userKeywords].join(', ')}`);
  if (constructiveShield) reasonParts.push('Constructive criticism shield applied');
  if (engagement) reasonParts.push(`Engagement raised priority by ${engagement}`);

  return {
    severity_score: Math.round(severity),
    engagement_score: Math.round(engagement),
    brand_risk_score: Math.round(brandScore),
    creator_risk_score: Math.round(Math.max(abuseScore, sarcasmScore)),
    priority_score: Math.round(priority),
    category,
    recommended_action: recommendedAction,
    reason: reasonParts.join(' | ') || 'No risky signals found',
    is_constructive: constructiveShield > 0,
    signal_evidence: {
      scam,
      impersonation,
      abuse,
      creatorImage,
      sarcasticHarm,
      brandRisk,
      userKeywords,
      constructive,
    },
  };
}

export function demoContent(platform = 'youtube') {
  const base = platform === 'instagram'
    ? { platform, external_id: 'ig-demo-1', title: 'Launch reel: new product reveal', thumbnail_url: '', comment_count: 184, view_count: 8200 }
    : { platform, external_id: 'yt-demo-1', title: 'I launched the first Block OFF demo', thumbnail_url: '', comment_count: 1248, view_count: 47200 };

  return [
    {
      ...base,
      id: 'demo-content-1',
      published_at: new Date(Date.now() - 86400000).toISOString(),
      risk_score: 91,
      top_comments: demoComments(platform).slice(0, 3),
    },
    {
      ...base,
      id: 'demo-content-2',
      external_id: platform === 'instagram' ? 'ig-demo-2' : 'yt-demo-2',
      title: platform === 'instagram' ? 'Behind the scenes reel' : 'How creators lose hours cleaning comments',
      comment_count: 416,
      view_count: 12900,
      published_at: new Date(Date.now() - 172800000).toISOString(),
      risk_score: 64,
      top_comments: demoComments(platform).slice(1, 4),
    },
  ];
}

export function demoComments(platform = 'youtube') {
  return [
    {
      id: `${platform}-comment-1`,
      external_id: `${platform}-comment-1`,
      platform,
      text: 'Message me on WhatsApp for giveaway prize. Click bit.ly/free-crypto now.',
      author_name: 'Prize Support',
      like_count: 2,
      reply_count: 0,
      ...scoreComment({ text: 'Message me on WhatsApp for giveaway prize. Click bit.ly/free-crypto now.', likeCount: 2 }),
      status: 'needs_review',
      demo: true,
    },
    {
      id: `${platform}-comment-2`,
      external_id: `${platform}-comment-2`,
      platform,
      text: 'Nobody asked for this. Delete your channel, you absolute clown.',
      author_name: 'Angry Viewer',
      like_count: 14,
      reply_count: 3,
      ...scoreComment({ text: 'Nobody asked for this. Delete your channel, you absolute clown.', likeCount: 14, replyCount: 3, isTopComment: true }),
      status: 'needs_review',
      demo: true,
    },
    {
      id: `${platform}-comment-3`,
      external_id: `${platform}-comment-3`,
      platform,
      text: 'This sponsorship feels shady. Can you explain why you promoted it?',
      author_name: 'Real Fan',
      like_count: 29,
      reply_count: 8,
      ...scoreComment({ text: 'This sponsorship feels shady. Can you explain why you promoted it?', likeCount: 29, replyCount: 8, isTopComment: true }),
      status: 'needs_review',
      demo: true,
    },
    {
      id: `${platform}-comment-4`,
      external_id: `${platform}-comment-4`,
      platform,
      text: 'Fake account pretending to be you is replying under every comment.',
      author_name: 'Community Helper',
      like_count: 7,
      reply_count: 1,
      ...scoreComment({ text: 'Fake account pretending to be you is replying under every comment.', likeCount: 7, replyCount: 1 }),
      status: 'needs_review',
      demo: true,
    },
  ].sort((a, b) => b.priority_score - a.priority_score);
}
