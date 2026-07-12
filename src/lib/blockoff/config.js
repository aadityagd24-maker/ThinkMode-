export const BLOCKOFF = {
  appPath: '/blockoff/app',
  siteUrl: import.meta.env.PUBLIC_SITE_URL || 'https://thinkmodeplus.com',
  youtubeScope: 'https://www.googleapis.com/auth/youtube.force-ssl',
  instagramScopes: [
    'instagram_business_basic',
    'instagram_business_manage_comments',
  ],
};

export function getPublicBaseUrl(requestUrl) {
  const configured = process.env.BLOCKOFF_BASE_URL
    || process.env.PUBLIC_SITE_URL
    || import.meta.env.BLOCKOFF_BASE_URL
    || import.meta.env.PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, '');

  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

export function getOAuthRedirectUri(platform, requestUrl) {
  const explicit = platform === 'youtube'
    ? process.env.YOUTUBE_REDIRECT_URI || import.meta.env.YOUTUBE_REDIRECT_URI
    : process.env.INSTAGRAM_REDIRECT_URI
      || process.env.META_REDIRECT_URI
      || import.meta.env.INSTAGRAM_REDIRECT_URI
      || import.meta.env.META_REDIRECT_URI;

  if (explicit) return explicit.trim();
  return `${getPublicBaseUrl(requestUrl)}/blockoff/auth/${platform}/callback`;
}
