/**
 * Keep a proposal only when its text can be found in the document.
 * Matching is normalised so typographic dashes and odd spaces do not defeat it.
 */

export function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function findInDocument(documentText: string, needle: string): boolean {
  const wanted = normalise(needle);
  if (!wanted) return false;
  return normalise(documentText).includes(wanted);
}

export function fenceDocument(documentText: string, instruction: string) {
  const fence = `DOC_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const clipped = documentText.slice(0, 12_000);
  return [
    instruction,
    '',
    `<<<${fence}`,
    clipped,
    `${fence}>>>`,
  ].join('\n');
}
