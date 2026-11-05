const LABELLED_LIST_LINE =
  /^[ \t]*[-*•+][ \t]+(?:entity|thread|fact|pending|entidade|fio|fato|pendente):[ \t]*[a-z0-9]+(?:-[a-z0-9]+)+.*$/gim;
const BARE_PROPOSALS_LINE = /^[ \t]*proposals[ \t]*:?[ \t]*$/gim;
const BOLD_LABEL = /(\*\*|__)[^*_\n]{1,60}(:(\*\*|__)|(\*\*|__):)[ \t]*/g;
const HEADING_MARKER = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const BOLD_MARKER = /\*\*|__/g;
const STAR_EMPHASIS = /(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g;
const UNDERSCORE_EMPHASIS = /(?<!\w)_(\S(?:[^_\n]*\S)?)_(?!\w)/g;
const CODE_MARKER = /`/g;
const BLANK_RUN = /\n{3,}/g;
const PROPOSALS_BLOCK = /^[\s*_#>-]*proposals[\s*_]*(:|$)/im;
const KEPT_WORDS = '$1';
const NOTHING = '';
const PARAGRAPH_BREAK = '\n\n';

export const hasProposalsBlock = (text: string): boolean => PROPOSALS_BLOCK.test(text);

export const playerTextOf = (text: string): string =>
  text
    .replace(LABELLED_LIST_LINE, NOTHING)
    .replace(BOLD_LABEL, NOTHING)
    .replace(BARE_PROPOSALS_LINE, NOTHING)
    .replace(HEADING_MARKER, NOTHING)
    .replace(BOLD_MARKER, NOTHING)
    .replace(STAR_EMPHASIS, KEPT_WORDS)
    .replace(UNDERSCORE_EMPHASIS, KEPT_WORDS)
    .replace(CODE_MARKER, NOTHING)
    .replace(BLANK_RUN, PARAGRAPH_BREAK)
    .trim();
