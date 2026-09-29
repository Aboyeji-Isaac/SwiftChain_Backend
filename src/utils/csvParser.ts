/**
 * Minimal RFC 4180 CSV parser.
 *
 * Written in-repo rather than pulled from a package because the bulk import
 * needs exact control over two things a general-purpose parser does not give
 * for free: per-row error reporting keyed to the original 1-based line number,
 * and a hard row cap enforced during parsing so an oversized upload is
 * rejected before it is fully materialised in memory.
 *
 * Supports quoted fields, escaped quotes (`""`), embedded commas and newlines
 * inside quotes, and CRLF or LF line endings.
 */

/** A parsed CSV row, keyed by header name, with its source line number. */
export interface CsvRow {
  /** 1-based line number in the original file, counting the header row. */
  lineNumber: number;
  values: Record<string, string>;
}

export interface CsvParseResult {
  headers: string[];
  rows: CsvRow[];
}

/** Raised when the input cannot be parsed as CSV at all. */
export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * Split raw CSV text into records of raw string fields.
 *
 * Tracks the line number each record started on so downstream errors can point
 * at the right line even when a quoted field spans several physical lines.
 */
function tokenize(input: string): Array<{ lineNumber: number; fields: string[] }> {
  const records: Array<{ lineNumber: number; fields: string[] }> = [];

  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  /** False until the current record has at least one character or delimiter. */
  let recordHasContent = false;

  const endField = (): void => {
    fields.push(field);
    field = '';
  };

  const endRecord = (): void => {
    endField();
    // Skip blank lines: a single empty field and no content seen.
    if (recordHasContent) {
      records.push({ lineNumber: recordStartLine, fields });
    }
    fields = [];
    recordHasContent = false;
    recordStartLine = line;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    switch (char) {
      case '"':
        inQuotes = true;
        recordHasContent = true;
        break;

      case ',':
        recordHasContent = true;
        endField();
        break;

      case '\r':
        // Swallow CR; the following LF terminates the record.
        break;

      case '\n':
        line += 1;
        endRecord();
        recordStartLine = line;
        break;

      default:
        if (char.trim() !== '') recordHasContent = true;
        field += char;
    }
  }

  if (inQuotes) {
    throw new CsvParseError('Malformed CSV: unterminated quoted field');
  }

  // Flush the final record when the file does not end with a newline.
  if (recordHasContent || fields.length > 0) {
    endRecord();
  }

  return records;
}

/** Normalise a header cell: trimmed and lowercased for case-insensitive matching. */
function normaliseHeader(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Parse CSV text into header-keyed rows.
 *
 * @param input   - Raw CSV text (a UTF-8 BOM, if present, is stripped).
 * @param maxRows - Maximum data rows to accept, excluding the header.
 * @throws {CsvParseError} If the file is empty, has no header, has duplicate
 *                         headers, or exceeds `maxRows`.
 */
export function parseCsv(input: string, maxRows: number): CsvParseResult {
  // Spreadsheet exports commonly prefix the file with a UTF-8 BOM, which
  // would otherwise become part of the first header name. Written as an
  // escape rather than a literal so the source stays free of invisible
  // characters.
  const text = input.replace(/^\uFEFF/, '');

  if (text.trim() === '') {
    throw new CsvParseError('CSV file is empty');
  }

  const records = tokenize(text);
  if (records.length === 0) {
    throw new CsvParseError('CSV file is empty');
  }

  const headers = records[0].fields.map(normaliseHeader);

  if (headers.some((header) => header === '')) {
    throw new CsvParseError('CSV header row contains an empty column name');
  }

  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length > 0) {
    throw new CsvParseError(
      `CSV header row contains duplicate column(s): ${[...new Set(duplicates)].join(', ')}`,
    );
  }

  const dataRecords = records.slice(1);

  if (dataRecords.length === 0) {
    throw new CsvParseError('CSV file contains a header row but no data rows');
  }

  if (dataRecords.length > maxRows) {
    throw new CsvParseError(
      `CSV file contains ${dataRecords.length} rows, which exceeds the limit of ${maxRows}`,
    );
  }

  const rows: CsvRow[] = dataRecords.map((record) => {
    const values: Record<string, string> = {};

    headers.forEach((header, index) => {
      // Short rows yield empty strings rather than undefined, so required-field
      // validation reports "missing" instead of throwing on a property access.
      values[header] = (record.fields[index] ?? '').trim();
    });

    return { lineNumber: record.lineNumber, values };
  });

  return { headers, rows };
}
