import { readDocumentXml, parseParagraphs } from './docx.js';

// Sections whose body is prose/steps rather than "Label: value" pairs.
const PROSE_SECTIONS = new Set(['approval process', 'content liability & copyright terms']);

// Blueprint label -> canonical field key.
const FIELD_MAP = {
  client: 'client',
  client_socials: 'socials',
  objective: 'objective',
  cta: 'cta',
  tags: 'tags',
  model: 'model_note',
  min_payout: 'min_payout',
  max_payout: 'max_payout',
  max_payout_per_channel: 'max_payout_per_channel',
  commission_rate: 'commission_rate',
  platforms: 'platforms',
  guidelines: 'guidelines',
  footage_raw_assets: 'footage',
  demo_video_style_reference: 'demo_video'
};

function normalizeLabel(label) {
  return label
    .replace(/:$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// "[Client Name]", "[$ amount]", "[X]% of sale value" are template placeholders,
// not real data. Treat a value as blank if it is wholly bracketed.
function isPlaceholder(value) {
  const v = value.trim();
  if (!v) return true;
  if (/^\[[^\]]*\]$/.test(v)) return true;
  // e.g. "[e.g. drive sales / conversions]" handled above; also catch a value
  // that is only a bracketed token plus boilerplate like "[X]% of sale value"
  if (/^\[[^\]]*\]\s*%?\s*(of\s+sale\s+value)?$/i.test(v)) return true;
  return false;
}

function cleanValue(value) {
  return isPlaceholder(value) ? '' : value.trim();
}

export function parseMoney(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[₹$,\s]/g, '');
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parseBlueprintParagraphs(paragraphs) {
  const result = {
    title: '',
    model: '',
    fields: {},
    extra_fields: [],
    approval_steps: [],
    terms: [],
    sections: []
  };

  let currentSection = '';

  for (const p of paragraphs) {
    const isTitle = /title/i.test(p.style);
    if (isTitle && !result.title) {
      result.title = p.text;
      continue;
    }

    const labelCandidate = p.boldText;
    const looksLikeField = labelCandidate.endsWith(':') && p.plainText !== '';
    const sectionKey = currentSection.toLowerCase();
    const inProseSection = PROSE_SECTIONS.has(sectionKey);

    if (!inProseSection && looksLikeField) {
      const rawLabel = labelCandidate.replace(/:$/, '').trim();
      const key = FIELD_MAP[normalizeLabel(rawLabel)];
      const value = cleanValue(p.plainText);
      if (key) result.fields[key] = value;
      else result.extra_fields.push({ label: rawLabel, value, section: currentSection });
      continue;
    }

    // A fully-bold line with no value is a section heading.
    if (p.allBold && !p.plainText) {
      currentSection = p.text.replace(/:$/, '').trim();
      result.sections.push(currentSection);
      continue;
    }

    if (sectionKey === 'approval process') result.approval_steps.push(p.text.replace(/^\d+[.)]\s*/, ''));
    else if (sectionKey === 'content liability & copyright terms') result.terms.push(p.text);
  }

  if (/affiliate/i.test(result.title)) result.model = 'affiliate';
  else if (/cpm/i.test(result.title)) result.model = 'cpm';

  return result;
}

// Shapes the parsed blueprint into the payload the admin confirm-modal edits and
// the campaign record stores. Anything absent from the document stays blank so
// the admin can fill it in before confirming.
export function toCampaignDraft(parsed) {
  const f = parsed.fields;
  return {
    model: parsed.model || '',
    title: parsed.title || '',
    name: f.client || '',
    socials: f.socials || '',
    objective: f.objective || '',
    cta: f.cta || '',
    tags: f.tags || '',
    platforms: f.platforms || '',
    guidelines: f.guidelines || '',
    footage: f.footage || '',
    demo_video: f.demo_video || '',
    model_note: f.model_note || '',
    commission_rate: f.commission_rate || '',
    min_payout: parseMoney(f.min_payout),
    max_payout: parseMoney(f.max_payout),
    max_payout_per_channel: parseMoney(f.max_payout_per_channel),
    // Not present in the blueprint template -- admin supplies these, and the
    // earnings allocator needs them.
    cpm: null,
    budget: null,
    description: '',
    approval_steps: parsed.approval_steps,
    terms: parsed.terms,
    extra_fields: parsed.extra_fields
  };
}

export async function parseBlueprintDocx(arrayBuffer) {
  const xml = await readDocumentXml(arrayBuffer);
  const paragraphs = parseParagraphs(xml);
  const parsed = parseBlueprintParagraphs(paragraphs);
  return toCampaignDraft(parsed);
}
