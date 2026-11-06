import { type Catalog, createTranslator } from './locale.ts';

export const GM_FAILURE_KINDS = [
  'limit',
  'auth',
  'notInstalled',
  'timeout',
  'exit',
  'lost',
  'malformed',
  'workspace',
  'reported',
  'other',
] as const;
export type GmFailureKind = (typeof GM_FAILURE_KINDS)[number];
export type GmFailure = { readonly kind: GmFailureKind; readonly detail?: string };

export const GM_FAILURE_CATALOG: Catalog = {
  en: {
    'gmFailure.limit': 'The AI game master is unavailable: Claude Code says your usage limit is reached.',
    'gmFailure.limitReset':
      'The AI game master is unavailable: Claude Code says your usage limit is reached. It resets {detail}.',
    'gmFailure.auth':
      'The AI game master is unavailable: Claude Code is not signed in. Run claude once in a terminal and sign in.',
    'gmFailure.notInstalled':
      'The AI game master is unavailable: Claude Code is not installed or could not be started.',
    'gmFailure.timeout': 'The AI game master is unavailable: it took too long to answer.',
    'gmFailure.exit': 'The AI game master is unavailable: Claude Code stopped with exit code {detail}.',
    'gmFailure.lost': 'The AI game master is unavailable: the reply was not saved.',
    'gmFailure.malformed': 'The AI game master is unavailable: Claude Code sent a malformed reply.',
    'gmFailure.workspace': 'The AI game master is unavailable: The Claude Code workspace could not be prepared.',
    'gmFailure.reported':
      'The AI game master is unavailable: Claude Code reported an error. Run claude once in a terminal to check that it is signed in.',
    'gmFailure.other': 'The AI game master is unavailable: {detail}',
    'gmFailure.kept': 'Your action is kept. Retry when the game master is back.',
    'gmFailure.retryHint': 'Type /retry to try again.',
  },
  es: {
    'gmFailure.limit': 'El GM de IA no está disponible: Claude Code indica que alcanzaste tu límite de uso.',
    'gmFailure.limitReset':
      'El GM de IA no está disponible: Claude Code indica que alcanzaste tu límite de uso. Se restablece {detail}.',
    'gmFailure.auth':
      'El GM de IA no está disponible: Claude Code no tiene la sesión iniciada. Ejecuta claude una vez en una terminal e inicia sesión.',
    'gmFailure.notInstalled': 'El GM de IA no está disponible: Claude Code no está instalado o no se pudo iniciar.',
    'gmFailure.timeout': 'El GM de IA no está disponible: tardó demasiado en responder.',
    'gmFailure.exit': 'El GM de IA no está disponible: Claude Code terminó con el código de salida {detail}.',
    'gmFailure.lost': 'El GM de IA no está disponible: la respuesta no se guardó.',
    'gmFailure.malformed': 'El GM de IA no está disponible: Claude Code envió una respuesta malformada.',
    'gmFailure.workspace': 'El GM de IA no está disponible: no se pudo preparar el espacio de trabajo de Claude Code.',
    'gmFailure.reported':
      'El GM de IA no está disponible: Claude Code informó un error. Ejecuta claude una vez en una terminal para comprobar que tienes la sesión iniciada.',
    'gmFailure.other': 'El GM de IA no está disponible: {detail}',
    'gmFailure.kept': 'Tu acción se conserva. Reintenta cuando el GM vuelva.',
    'gmFailure.retryHint': 'Escribe /reintentar para intentarlo de nuevo.',
  },
  'pt-BR': {
    'gmFailure.limit': 'O GM de IA não está disponível: o Claude Code diz que você atingiu o limite de uso.',
    'gmFailure.limitReset':
      'O GM de IA não está disponível: o Claude Code diz que você atingiu o limite de uso. Ele é renovado {detail}.',
    'gmFailure.auth':
      'O GM de IA não está disponível: o Claude Code não está conectado. Execute claude uma vez em um terminal e entre na sua conta.',
    'gmFailure.notInstalled':
      'O GM de IA não está disponível: o Claude Code não está instalado ou não pôde ser iniciado.',
    'gmFailure.timeout': 'O GM de IA não está disponível: ele demorou demais para responder.',
    'gmFailure.exit': 'O GM de IA não está disponível: o Claude Code parou com o código de saída {detail}.',
    'gmFailure.lost': 'O GM de IA não está disponível: a resposta não foi salva.',
    'gmFailure.malformed': 'O GM de IA não está disponível: o Claude Code enviou uma resposta malformada.',
    'gmFailure.workspace':
      'O GM de IA não está disponível: não foi possível preparar o espaço de trabalho do Claude Code.',
    'gmFailure.reported':
      'O GM de IA não está disponível: o Claude Code relatou um erro. Execute claude uma vez em um terminal para confirmar que você está conectado.',
    'gmFailure.other': 'O GM de IA não está disponível: {detail}',
    'gmFailure.kept': 'Sua ação foi mantida. Tente de novo quando o GM voltar.',
    'gmFailure.retryHint': 'Digite /repetir para tentar de novo.',
  },
};

const translate = createTranslator(GM_FAILURE_CATALOG);

export const gmFailureText = (locale: string, { kind, detail }: GmFailure): string =>
  translate(locale, kind === 'limit' && detail !== undefined ? 'gmFailure.limitReset' : `gmFailure.${kind}`, {
    detail,
  });

export const gmFailureKept = (locale: string): string => translate(locale, 'gmFailure.kept');
export const gmFailureRetryHint = (locale: string): string => translate(locale, 'gmFailure.retryHint');
