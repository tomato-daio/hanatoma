import { describe, expect, it } from 'vitest';
import { TTS_CACHE_LIMIT, TtsCache, buildSsml, ttsCacheKey } from './azureTts';

describe('buildSsml', () => {
  it('speak/voice/prosodyの入れ子構造とen-USロケールを持つSSMLを組み立てる', () => {
    const ssml = buildSsml('Hello there.', 'en-US-JennyNeural', '-15%');
    expect(ssml).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
        '<voice name="en-US-JennyNeural">' +
        '<prosody rate="-15%">Hello there.</prosody>' +
        '</voice>' +
        '</speak>',
    );
  });

  it('rate 0%（レベル4/5）もそのまま入る', () => {
    expect(buildSsml('Hi.', 'en-US-GuyNeural', '0%')).toContain('<prosody rate="0%">Hi.</prosody>');
  });

  it('テキスト中のXML特殊文字5種をエスケープする', () => {
    const ssml = buildSsml(`Tom & Jerry say "1 < 2 > 0" & it's true`, 'en-US-JennyNeural', '0%');
    expect(ssml).toContain(
      'Tom &amp; Jerry say &quot;1 &lt; 2 &gt; 0&quot; &amp; it&apos;s true',
    );
    // 生の特殊文字がテキスト部分に残っていない（タグ以外に < や生の & が無い）
    expect(ssml).not.toContain('Tom & Jerry');
    expect(ssml).not.toContain('1 < 2');
  });

  it('アポストロフィを含む自然な英文が壊れない（会話文で頻出）', () => {
    const ssml = buildSsml("I'm sorry, I didn't catch that.", 'en-US-JennyNeural', '-8%');
    expect(ssml).toContain('I&apos;m sorry, I didn&apos;t catch that.');
  });

  it('voice/rate属性値もエスケープされ、SSML構造を壊せない', () => {
    const ssml = buildSsml('Hi.', 'bad"voice<name', '"><break/>');
    // 属性の閉じ引用符を突き破る生の " や < が属性値に残らない
    expect(ssml).toContain('<voice name="bad&quot;voice&lt;name">');
    expect(ssml).toContain('<prosody rate="&quot;&gt;&lt;break/&gt;">');
    expect(ssml).not.toContain('<break/>');
  });

  it('空テキストでも構造は保たれる', () => {
    const ssml = buildSsml('', 'en-US-JennyNeural', '0%');
    expect(ssml).toContain('<prosody rate="0%"></prosody>');
  });
});

describe('ttsCacheKey', () => {
  it('同一(text,voice,rate)は同じキーになる', () => {
    expect(ttsCacheKey('a', 'b', 'c')).toBe(ttsCacheKey('a', 'b', 'c'));
  });

  it('いずれか1要素でも違えば別キーになる', () => {
    const base = ttsCacheKey('hello', 'en-US-JennyNeural', '0%');
    expect(ttsCacheKey('hello!', 'en-US-JennyNeural', '0%')).not.toBe(base);
    expect(ttsCacheKey('hello', 'en-US-GuyNeural', '0%')).not.toBe(base);
    expect(ttsCacheKey('hello', 'en-US-JennyNeural', '-15%')).not.toBe(base);
  });

  it('要素の区切り位置が違うだけの入力が衝突しない（区切り文字混入対策）', () => {
    // 素朴な 'a|b|c' 連結だと同一キーになる組み合わせ
    expect(ttsCacheKey('a|b', 'c', 'd')).not.toBe(ttsCacheKey('a', 'b|c', 'd'));
    expect(ttsCacheKey('a,b', 'c', 'd')).not.toBe(ttsCacheKey('a', 'b,c', 'd'));
  });
});

/** テスト用: 各バイトをfillで埋めたArrayBufferを作る。 */
function buf(fill: number, length = 4): ArrayBuffer {
  const b = new ArrayBuffer(length);
  new Uint8Array(b).fill(fill);
  return b;
}

function firstByte(b: ArrayBuffer): number {
  return new Uint8Array(b)[0];
}

describe('TtsCache', () => {
  it('setした値をgetで取得できる', () => {
    const cache = new TtsCache();
    cache.set('k', buf(7));
    const hit = cache.get('k');
    expect(hit).toBeDefined();
    expect(firstByte(hit!)).toBe(7);
  });

  it('未登録キーはundefined', () => {
    const cache = new TtsCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('上限の既定は50（DESIGN.md §6c）', () => {
    expect(TTS_CACHE_LIMIT).toBe(50);
    const cache = new TtsCache();
    for (let i = 0; i < 60; i++) cache.set(`k${i}`, buf(i));
    expect(cache.size).toBe(50);
  });

  it('上限を超えると最も古いエントリから捨てる', () => {
    const cache = new TtsCache(2);
    cache.set('a', buf(1));
    cache.set('b', buf(2));
    cache.set('c', buf(3)); // 'a'が追い出される
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('getしたエントリは「最近使った」扱いになり追い出されにくい（LRU）', () => {
    const cache = new TtsCache(2);
    cache.set('a', buf(1));
    cache.set('b', buf(2));
    cache.get('a'); // 'a'を最近側へ
    cache.set('c', buf(3)); // 追い出されるのは'b'
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('同じキーへのsetは上書きし、件数は増えない', () => {
    const cache = new TtsCache(2);
    cache.set('a', buf(1));
    cache.set('a', buf(9));
    expect(cache.size).toBe(1);
    expect(firstByte(cache.get('a')!)).toBe(9);
  });

  it('getが返すバッファはコピー: 呼び出し側が書き換えても次回のgetに影響しない（decodeAudioDataのdetach対策）', () => {
    const cache = new TtsCache();
    cache.set('k', buf(5));
    const first = cache.get('k')!;
    new Uint8Array(first).fill(0); // 呼び出し側での破壊を模す
    const second = cache.get('k')!;
    expect(firstByte(second)).toBe(5);
  });

  it('setはコピーを保存: 呼び出し側が渡した後に書き換えてもキャッシュに影響しない', () => {
    const cache = new TtsCache();
    const original = buf(5);
    cache.set('k', original);
    new Uint8Array(original).fill(0);
    expect(firstByte(cache.get('k')!)).toBe(5);
  });

  it('clearで全件消える', () => {
    const cache = new TtsCache();
    cache.set('a', buf(1));
    cache.set('b', buf(2));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
