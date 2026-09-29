/**
 * Unit tests for the RFC 4180 CSV parser used by the bulk delivery import.
 *
 * Pure functions with no I/O, so these run without a database.
 */

import { CsvParseError, parseCsv } from '../src/utils/csvParser';

const MAX_ROWS = 100;

describe('parseCsv', () => {
  it('parses a simple file into header-keyed rows', () => {
    const result = parseCsv('name,age\nAda,36\nGrace,45\n', MAX_ROWS);

    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].values).toEqual({ name: 'Ada', age: '36' });
    expect(result.rows[1].values).toEqual({ name: 'Grace', age: '45' });
  });

  it('lowercases and trims header names', () => {
    const result = parseCsv('  Name , AGE \nAda,36\n', MAX_ROWS);
    expect(result.headers).toEqual(['name', 'age']);
  });

  it('reports the source line number for each row', () => {
    const result = parseCsv('name\nAda\nGrace\n', MAX_ROWS);
    expect(result.rows.map((row) => row.lineNumber)).toEqual([2, 3]);
  });

  it('handles quoted fields containing commas', () => {
    const result = parseCsv('name,address\nAda,"12 High St, London"\n', MAX_ROWS);
    expect(result.rows[0].values.address).toBe('12 High St, London');
  });

  it('handles escaped double quotes inside quoted fields', () => {
    const result = parseCsv('name,note\nAda,"She said ""hello"""\n', MAX_ROWS);
    expect(result.rows[0].values.note).toBe('She said "hello"');
  });

  it('handles newlines inside quoted fields without splitting the row', () => {
    const result = parseCsv('name,note\nAda,"line one\nline two"\n', MAX_ROWS);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].values.note).toBe('line one\nline two');
  });

  it('keeps line numbers correct after a multi-line quoted field', () => {
    const result = parseCsv('name,note\nAda,"one\ntwo"\nGrace,fine\n', MAX_ROWS);

    expect(result.rows).toHaveLength(2);
    // Grace starts on physical line 4 because Ada's note spans lines 2-3.
    expect(result.rows[1].lineNumber).toBe(4);
  });

  it('parses CRLF line endings', () => {
    const result = parseCsv('name,age\r\nAda,36\r\n', MAX_ROWS);
    expect(result.rows[0].values).toEqual({ name: 'Ada', age: '36' });
  });

  it('parses a final row with no trailing newline', () => {
    const result = parseCsv('name\nAda', MAX_ROWS);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].values.name).toBe('Ada');
  });

  it('skips blank lines between rows', () => {
    const result = parseCsv('name\nAda\n\nGrace\n', MAX_ROWS);
    expect(result.rows.map((row) => row.values.name)).toEqual(['Ada', 'Grace']);
  });

  it('strips a UTF-8 byte order mark from the first header', () => {
    const result = parseCsv('﻿name,age\nAda,36\n', MAX_ROWS);
    expect(result.headers).toEqual(['name', 'age']);
  });

  it('pads short rows with empty strings rather than undefined', () => {
    const result = parseCsv('name,age,city\nAda,36\n', MAX_ROWS);
    expect(result.rows[0].values).toEqual({ name: 'Ada', age: '36', city: '' });
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv('', MAX_ROWS)).toThrow(CsvParseError);
    expect(() => parseCsv('   \n  ', MAX_ROWS)).toThrow(CsvParseError);
  });

  it('rejects a file with headers but no data rows', () => {
    expect(() => parseCsv('name,age\n', MAX_ROWS)).toThrow(/no data rows/i);
  });

  it('rejects duplicate header names', () => {
    expect(() => parseCsv('name,name\nAda,Grace\n', MAX_ROWS)).toThrow(/duplicate/i);
  });

  it('rejects an empty header cell', () => {
    expect(() => parseCsv('name,,age\nAda,x,36\n', MAX_ROWS)).toThrow(/empty column name/i);
  });

  it('rejects an unterminated quoted field', () => {
    expect(() => parseCsv('name\n"unterminated\n', MAX_ROWS)).toThrow(/unterminated/i);
  });

  it('rejects a file exceeding the row limit', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `row${i}`).join('\n');
    expect(() => parseCsv(`name\n${rows}\n`, 3)).toThrow(/exceeds the limit of 3/);
  });

  it('accepts a file exactly at the row limit', () => {
    const rows = Array.from({ length: 3 }, (_, i) => `row${i}`).join('\n');
    const result = parseCsv(`name\n${rows}\n`, 3);
    expect(result.rows).toHaveLength(3);
  });
});
