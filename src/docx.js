// Minimal ZIP reader for .docx files. A .docx is a ZIP archive; we only need
// word/document.xml. Uses the platform DecompressionStream so there is no
// third-party dependency and nothing to bundle.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEocd(view, bytes) {
  // EOCD is at the end, but may be followed by up to 64KB of comment.
  const minPos = Math.max(0, bytes.length - 65558);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

export async function readDocxEntry(arrayBuffer, wantedName) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  const eocd = findEocd(view, bytes);
  if (eocd === -1) throw new Error('Not a valid .docx file (no ZIP directory found)');

  const entryCount = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== CEN_SIG) break;

    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    // The spec mandates '/', but some Windows zip writers emit '\'.
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, '/');

    if (name === wantedName) {
      // Local header: name/extra lengths here can differ from the central copy.
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return decoder.decode(data);
      if (method === 8) return decoder.decode(await inflateRaw(data));
      throw new Error(`Unsupported ZIP compression method ${method}`);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`${wantedName} not found — is this a Word .docx file?`);
}

export function readDocumentXml(arrayBuffer) {
  return readDocxEntry(arrayBuffer, 'word/document.xml');
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function runText(runXml) {
  // <w:tab/> and <w:br/> render as whitespace; <w:t> holds the literal text.
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  let m;
  while ((m = re.exec(runXml)) !== null) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else out += ' ';
  }
  return out;
}

// Splits a paragraph into bold-prefix and remainder. The blueprint puts every
// field label in a bold run ending with ':' and the value in plain runs after.
export function parseParagraph(paraXml) {
  const style = (paraXml.match(/<w:pStyle\s+w:val="([^"]+)"/) || [])[1] || '';
  const isNumbered = /<w:numPr>/.test(paraXml);

  const runs = [];
  const re = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  let m;
  while ((m = re.exec(paraXml)) !== null) {
    const xml = m[0];
    const rPr = (xml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    runs.push({ text: runText(xml), bold: /<w:b\s*\/>|<w:b\s+[^>]*\/>/.test(rPr) });
  }

  const text = runs.map(r => r.text).join('');
  const boldText = runs.filter(r => r.bold).map(r => r.text).join('');
  const plainText = runs.filter(r => !r.bold).map(r => r.text).join('');

  return {
    style,
    isNumbered,
    text: text.trim(),
    boldText: boldText.trim(),
    plainText: plainText.trim(),
    allBold: runs.length > 0 && runs.every(r => !r.text.trim() || r.bold)
  };
}

export function parseParagraphs(documentXml) {
  const bodyStart = documentXml.indexOf('<w:body>');
  const bodyEnd = documentXml.indexOf('</w:body>');
  const body = bodyStart === -1 ? documentXml : documentXml.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);

  const out = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const p = parseParagraph(m[0]);
    if (p.text) out.push(p);
  }
  return out;
}
