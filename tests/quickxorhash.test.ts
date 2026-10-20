import { describe, expect, it } from 'vitest';
import { QuickXorHash } from '../src/core/quickxorhash.js';

// Test vectors published by rclone (backend/onedrive/quickxorhash/quickxorhash_test.go):
// input (base64) → quickXorHash (base64)
const vectors: Array<[string, string]> = [
  ['', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='],
  ['Sg==', 'SgAAAAAAAAAAAAAAAQAAAAAAAAA='],
  ['tbQ=', 'taAFAAAAAAAAAAAAAgAAAAAAAAA='],
  ['0pZP', '0rDEEwAAAAAAAAAAAwAAAAAAAAA='],
  ['jRRDVA==', 'jaDAEKgAAAAAAAAABAAAAAAAAAA='],
  ['eAV52qE=', 'eChAHrQRCgAAAAAABQAAAAAAAAA='],
  ['luBZlaT6', 'lgBHFipBCn0AAAAABgAAAAAAAAA='],
  ['qaApEj66lw==', 'qQBFCiTgA11cAgAABwAAAAAAAAA='],
  ['/aNzzCFPS/A=', '/RjFHJgRgicsAR4ACAAAAAAAAAA='],
  ['n6Neh7p6fFgm', 'nxiFFw6hCz3wAQsmCQAAAAAAAAA='],
  ['J9iPGCbfZSTNyw==', 'J8DGIzBggm+UgQTNUgYAAAAAAAA='],
  ['i+UZyUGJKh+ISbk=', 'iyhHBpIRhESo4AOIQ0IuAAAAAAA='],
  ['h490d57Pqz5q2rtT', 'h3gEHe7giWeswgdq3MYupgAAAAA='],
  ['vPgoDjOfO6fm71RxLw==', 'vMAHChwwg0/s4BTmdQcV4vACAAA='],
  ['XoJ1AsoR4fDYJrDqYs4=', 'XhBEHQSgjAiEAx7YPgEs1CEGZwA='],
  ['gQaybEqS/4UlDc8e4IJm', 'gDCALNigBEn8oxAlZ8AzPAAOQZg='],
  ['2fuxhBJXtpWFe8dOfdGeHw==', 'O9tHLAghgSvYohKFyMMxnNCHaHg='],
  ['XBV6YKU9V7yMakZnFIxIkuU=', 'HbplHsBQih5cgReMQYMRzkABRiA='],
  ['XJZSOiNO2bmfKnTKD7fztcQX', '/6ZArHQwAidkIxefQgEdlPGAW8w='],
  ['g8VtAh+2Kf4k0kY5tzji2i2zmA==', 'wDNrgwHWAVukwB8kg4YRcnALHIg='],
  ['T6LYJIfDh81JrAK309H2JMJTXis=', 'zBTHrspn3mEcohlJdIUAbjGNaNg='],
  ['DWAAX5/CIfrmErgZa8ot6ZraeSbu', 'LR2Z0PjuRYGKQB/mhQAuMrAGZbQ='],
  ['N9abi3qy/mC1THZuVLHPpx7SgwtLOA==', '1KTYttCBEen8Hwy1doId3ECFWDw='],
  ['LlUe7wHerLqEtbSZLZgZa9u0m7hbiFs=', 'TqVZpxs3cN61BnuFvwUtMtECTGQ='],
  ['bU2j/0XYdgfPFD4691jV0AOUEUPR4Z5E', 'bnLBiLpVgnxVkXhNsIAPdHAPLFQ='],
  ['lScPwPsyUsH2T1Qsr31wXtP55Wqbe47Uyg==', 'VDMSy8eI26nBHCB0e8gVWPCKPsA='],
  ['rJaKh1dLR1k+4hynliTZMGf8Nd4qKKoZiAM=', 'r7bjwkl8OYQeNaMcCY8fTmEJEmQ='],
  ['pPsT0CPmHrd3Frsnva1pB/z1ytARLeHEYRCo', 'Rdg7rCcDomL59pL0s6GuTvqLVqQ='],
  ['wSRChaqmrsnMrfB2yqI43eRWbro+f9kBvh+01w==', 'YTtloIi6frI7HX3vdLvE7I2iUOA='],
  ['apL67KMIRxQeE9k1/RuW09ppPjbF1WeQpTjSWtI=', 'CIpedls+ZlSQ654fl+X26+Q7LVU='],
  ['53yx0/QgMTVb7OOzHRHbkS7ghyRc+sIXxi7XHKgT', 'zfJtLGFgR9DB3Q64fAFIp+S5iOY='],
  ['PwXNnutoLLmxD8TTog52k8cQkukmT87TTnDipKLHQw==', 'PTaGs7yV3FUyBy/SfU6xJRlCJlI='],
  ['NbYXsp5/K6mR+NmHwExjvWeWDJFnXTKWVlzYHoesp2E=', 'wjuAuWDiq04qDt1R8hHWDDcwVoQ='],
  ['qQ70RB++JAR5ljNv3lJt1PpqETPsckopfonItu18Cr3E', 'FkJaeg/0Z5+euShYlLpE2tJh+Lo='],
  ['RhzSatQTQ9/RFvpHyQa1WLdkr3nIk6MjJUma998YRtp44A==', 'SPN2D29reImAqJezlqV2DLbi8tk='],
  ['DND1u1uZ5SqZVpRUk6NxSUdVo7IjjL9zs4A1evDNCDLcXWc=', 'S6lBk2hxI2SWBfn7nbEl7D19UUs='],
  ['jEi62utFz69JMYHjg1iXy7oO6ZpZSLcVd2B+pjm6BGsv/CWi', 's0lYU9tr/bp9xsnrrjYgRS5EvV8='],
  ['hfS3DZZnhy0hv7nJdXLv/oJOtIgAuP9SInt/v8KeuO4/IvVh4A==', 'CV+HQCdd2A/e/vdi12f2UU55GLA='],
  ['EkPQAC6ymuRrYjIXD/LT/4Vb+7aTjYVZOHzC8GPCEtYDP0+T3Nc=', 'kE9H9sEmr3vHBYUiPbvsrcDgSEo='],
  ['vtBOGIENG7yQ/N7xNWPNIgy66Gk/I2Ur/ZhdFNUK9/1FCZuu/KeS', '+Fgp3HBimtCzUAyiinj3pkarYTk='],
  ['YnF4smoy9hox2jBlJ3VUa4qyCRhOZbWcmFGIiszTT4zAdYHsqJazyg==', 'arkIn+ELddmE8N34J9ydyFKW+9w='],
  ['0n7nl3YJtipy6yeUbVPWtc2h45WbF9u8hTz5tNwj3dZZwfXWkk+GN3g=', 'YJLNK7JR64j9aODWfqDvEe/u6NU='],
  ['FnIIPHayc1pHkY4Lh8+zhWwG8xk6Knk/D3cZU1/fOUmRAoJ6CeztvMOL', '22RPOylMtdk7xO/QEQiMli4ql0k='],
  ['J82VT7ND0Eg1MorSfJMUhn+qocF7PsUpdQAMrDiHJ2JcPZAHZ2nyuwjoKg==', 'pOR5eYfwCLRJbJsidpc1rIJYwtM='],
  ['Zbu+78+e35ZIymV5KTDdub5McyI3FEO8fDxs62uWHQ9U3Oh3ZqgaZ30SnmQ=', 'DbvbTkgNTgWRqRidA9r1jhtUjro='],
  ['lgybK3Da7LEeY5aeeNrqcdHvv6mD1W4cuQ3/rUj2C/CNcSI0cAMw6vtpVY3y', '700RQByn1lRQSSme9npQB/Ye+bY='],
  ['jStZgKHv4QyJLvF2bYbIUZi/FscHALfKHAssTXkrV1byVR9eACwW9DNZQRHQwg==', 'uwN55He8xgE4g93dH9163xPew4U='],
  ['V1PSud3giF5WW72JB/bgtltsWtEB5V+a+wUALOJOGuqztzVXUZYrvoP3XV++gM0=', 'U+3ZfUF/6mwOoHJcSHkQkckfTDA='],
  ['VXs4t4tfXGiWAL6dlhEMm0YQF0f2w9rzX0CvIVeuW56o6/ec2auMpKeU2VeteEK5', 'sq24lSf7wXLH8eigHl07X+qPTps='],
  ['bLUn3jLH+HFUsG3ptWTHgNvtr3eEv9lfKBf0jm6uhpqhRwtbEQ7Ovj/hYQf42zfdtQ==', 'uC8xrnopGiHebGuwgq607WRQyxQ='],
  ['4SVmjtXIL8BB8SfkbR5Cpaljm2jpyUfAhIBf65XmKxHlz9dy5XixgiE/q1lv+esZW/E=', 'wxZ0rxkMQEnRNAp8ZgEZLT4RdLM='],
  ['pMljctlXeFUqbG3BppyiNbojQO3ygg6nZPeUZaQcVyJ+Clgiw3Q8ntLe8+02ZSfyCc39', 'aZEPmNvOXnTt7z7wt+ewV7QGMlg='],
  ['C16uQlxsHxMWnV2gJhFPuJ2/guZ4N1YgmNvAwL1yrouGQtwieGx8WvZsmYRnX72JnbVtTw==', 'QtlSNqXhVij64MMhKJ3EsDFB/z8='],
  ['7ZVDOywvrl3L0GyKjjcNg2CcTI81n2CeUbzdYWcZOSCEnA/xrNHpiK01HOcGh3BbxuS4S6g=', '4NznNJc4nmXeApfiCFTq/H5LbHw='],
  ['JXm2tTVqpYuuz2Cc+ZnPusUb8vccPGrzWK2oVwLLl/FjpFoxO9FxGlhnB08iu8Q/XQSdzHn+', 'IwE5+2pKNcK366I2k2BzZYPibSI='],
  ['TiiU1mxzYBSGZuE+TX0l9USWBilQ7dEml5lLrzNPh75xmhjIK8SGqVAkvIMgAmcMB+raXdMPZg==', 'yECGHtgR128ScP4XlvF96eLbIBE='],
  ['zz+Q4zi6wh0fCJUFU9yUOqEVxlIA93gybXHOtXIPwQQ44pW4fyh6BRgc1bOneRuSWp85hwlTJl8=', '+3Ef4D6yuoC8J+rbFqU1cegverE='],
  ['sa6SHK9z/G505bysK5KgRO2z2cTksDkLoFc7sv0tWBmf2G2mCiozf2Ce6EIO+W1fRsrrtn/eeOAV', 'xZg1CwMNAjN0AIXw2yh4+1N3oos='],
];

describe('QuickXorHash', () => {
  it('matches the published test vectors', () => {
    for (const [inB64, expected] of vectors) {
      const input = Buffer.from(inB64, 'base64');
      expect(QuickXorHash.ofBuffer(input), `input length ${input.length}`).toBe(expected);
    }
  });

  it('is independent of chunking (streaming)', () => {
    const data = Buffer.alloc(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
    const whole = QuickXorHash.ofBuffer(data);
    for (const chunk of [1, 7, 64, 1759, 1760, 1761, 4096]) {
      const h = new QuickXorHash();
      for (let o = 0; o < data.length; o += chunk) h.update(data.subarray(o, Math.min(o + chunk, data.length)));
      expect(h.digestBase64(), `chunk ${chunk}`).toBe(whole);
    }
  });

  it('distinguishes content of equal length', () => {
    expect(QuickXorHash.ofBuffer(Buffer.from('hello world'))).not.toBe(QuickXorHash.ofBuffer(Buffer.from('hello worle')));
  });
});
