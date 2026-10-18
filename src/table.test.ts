import { describe, expect, it } from 'vitest';
import { exportCSV, parseCSV } from './table';
describe('CSV boundaries', () => {
  it('handles BOM, unicode, escaped quotes, multiline fields and short records', () => {
    const data = parseCSV(
      '\uFEFFИмя;Описание;Сумма\r\nАня;"Сказала ""да"";\r\nвторая строка";12\r\nБорис',
    );
    expect(data.columns).toEqual(['Имя', 'Описание', 'Сумма']);
    expect(data.rows[0][1]).toBe('Сказала "да";\r\nвторая строка');
    expect(data.rows[1]).toEqual(['Борис', '', '']);
  });
  it('rejects malformed quotes and overflow values', () => {
    expect(() => parseCSV('a,b\n"oops')).toThrow();
    expect(() => parseCSV('a,b\nx,y,z')).toThrow('больше значений');
  });
  it('neutralizes dangerous headers and values in Excel exports', () => {
    const data = parseCSV(
      exportCSV(
        ['=formula', 'normal'],
        [
          ['  @cmd', '\t1+2'],
          ['-1', 'safe'],
        ],
        ';',
      ),
      ';',
    );
    expect(data.columns[0]).toBe("'=formula");
    expect(data.rows).toEqual([
      ["'  @cmd", "'\t1+2"],
      ["'-1", 'safe'],
    ]);
  });
});
