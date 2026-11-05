export type Catalog = Readonly<Record<string, Readonly<Record<string, string>>>>;
export type Params = Readonly<Record<string, unknown>>;
export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_LOCALE = 'en';
export const LANGUAGE_ENV = 'RPG_LANG';

const LOCALE_ENV = [LANGUAGE_ENV, 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const;
const POSIX_LOCALES: ReadonlySet<string> = new Set(['C', 'POSIX']);
const POSIX_SUFFIX = /[.@].*$/;
const POSIX_SEPARATOR = '_';
const TAG_SEPARATOR = '-';
const PLACEHOLDER = /\{(\w+)\}/g;
const COUNT = 'count';
const PLURAL_FALLBACK = 'other';

const tagOf = (value: string) => value.replace(POSIX_SUFFIX, '').replaceAll(POSIX_SEPARATOR, TAG_SEPARATOR);

export const systemLocale = (env: Environment): string => {
  const named = LOCALE_ENV.map((name) => tagOf(env[name] ?? '')).find((tag) => tag !== '' && !POSIX_LOCALES.has(tag));
  return named ?? Intl.DateTimeFormat().resolvedOptions().locale;
};

const canonical = (requested: string) => {
  try {
    return Intl.getCanonicalLocales(requested)[0];
  } catch {
    return undefined;
  }
};

export const safeLocale = (requested: string): string => canonical(requested) ?? DEFAULT_LOCALE;

export const matchLocale = (requested: string, supported: readonly string[], fallback = DEFAULT_LOCALE): string => {
  const tag = canonical(tagOf(requested));
  if (tag === undefined) return fallback;
  const { language } = new Intl.Locale(tag);
  return (
    supported.find((locale) => locale.toLowerCase() === tag.toLowerCase()) ??
    supported.find((locale) => new Intl.Locale(locale).language === language) ??
    fallback
  );
};

export const localeOf = (env: Environment, supported: readonly string[]): string =>
  matchLocale(systemLocale(env), supported);

export const missingKeys = (catalog: Catalog): string[] => {
  const keys = [...new Set(Object.values(catalog).flatMap((entries) => Object.keys(entries)))];
  return Object.entries(catalog).flatMap(([locale, entries]) =>
    keys.filter((key) => !Object.hasOwn(entries, key)).map((key) => `${locale} ${key}`),
  );
};

const formatted = (locale: string, value: unknown) =>
  typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : String(value);

export const createTranslator = (catalog: Catalog) => {
  const fallback = catalog[DEFAULT_LOCALE] ?? {};
  return (requested: string, key: string, params: Params = {}): string => {
    const locale = safeLocale(requested);
    const entries = catalog[requested] ?? {};
    const lookup = (name: string) => entries[name] ?? fallback[name];
    const count = params[COUNT];
    const plural =
      typeof count === 'number'
        ? (lookup(`${key}.${new Intl.PluralRules(locale).select(count)}`) ?? lookup(`${key}.${PLURAL_FALLBACK}`))
        : undefined;
    return (plural ?? lookup(key) ?? key).replace(PLACEHOLDER, (placeholder, name) =>
      Object.hasOwn(params, name) ? formatted(locale, params[name]) : placeholder,
    );
  };
};
