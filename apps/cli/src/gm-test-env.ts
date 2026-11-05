import { API_KEY_ENV, GM_API_URL_ENV, GM_KEYCHAIN_ENV, KEYCHAIN_OFF } from './gm-api.ts';

export const CLOSED_PROVIDER_URL = 'http://127.0.0.1:1/v1/messages';

export const hermeticGmEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { [API_KEY_ENV]: _key, ...rest } = env;
  return { ...rest, [GM_API_URL_ENV]: CLOSED_PROVIDER_URL, [GM_KEYCHAIN_ENV]: KEYCHAIN_OFF };
};
