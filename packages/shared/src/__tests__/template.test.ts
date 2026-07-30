import {describe, expect, it} from 'vitest';
import {escapeHtml, renderTemplate} from '../template';

describe('escapeHtml', () => {
  it('escapes the five HTML-special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('嗨 朋友 hello-world_123')).toBe('嗨 朋友 hello-world_123');
  });
});

describe('renderTemplate', () => {
  it('replaces variables (documented examples)', () => {
    expect(renderTemplate('Hello {{name}}!', {name: 'World'})).toBe('Hello World!');
    expect(renderTemplate('Hello {{data.name}}!', {data: {name: 'World'}})).toBe('Hello World!');
    expect(renderTemplate('Hello {{name ?? Guest}}!', {})).toBe('Hello Guest!');
  });

  it('falls back to the data object for bare keys', () => {
    expect(renderTemplate('Hi {{firstName}}', {data: {firstName: 'Ada'}})).toBe('Hi Ada');
  });

  it('renders numbers, including 0 via the data object', () => {
    // Send paths pass contact data both spread at top level and under `data`;
    // the `||` lookup chain drops a top-level 0, the data lookup catches it
    expect(renderTemplate('{{bonus_days}} days', {bonus_days: 0, data: {bonus_days: 0}})).toBe('0 days');
    expect(renderTemplate('{{bonus_days}} days', {bonus_days: 7})).toBe('7 days');
  });

  describe('without escapeHtml (plain-text contexts like subjects)', () => {
    it('substitutes values verbatim', () => {
      expect(renderTemplate('Hi {{name}}', {name: '<b>Ada & Eve</b>'})).toBe('Hi <b>Ada & Eve</b>');
    });

    it('wraps array values in <li> without escaping elements', () => {
      expect(renderTemplate('<ul>{{items}}</ul>', {items: ['a', 'b']})).toBe('<ul><li>a</li>\n<li>b</li></ul>');
    });
  });

  describe('with escapeHtml (HTML bodies)', () => {
    const html = {escapeHtml: true};

    it('renders user-controlled values as inert text', () => {
      expect(renderTemplate('Hi {{display_name}}', {display_name: '<b>Ada</b>'}, html)).toBe(
        'Hi &lt;b&gt;Ada&lt;/b&gt;',
      );
    });

    it('neutralizes comment-breaking sequences', () => {
      expect(renderTemplate('<!-- greet {{display_name}} -->', {display_name: '--><script>x</script>'}, html)).toBe(
        '<!-- greet --&gt;&lt;script&gt;x&lt;/script&gt; -->',
      );
    });

    it('does not escape the template text itself', () => {
      expect(renderTemplate('<p>Hi {{name}} &amp; co</p>', {name: 'Ada'}, html)).toBe('<p>Hi Ada &amp; co</p>');
    });

    it('keeps URLs usable in href attributes', () => {
      const rendered = renderTemplate('<a href="{{gift_url}}">', {gift_url: 'https://x.tw/gift?token=abc123'}, html);
      expect(rendered).toBe('<a href="https://x.tw/gift?token=abc123">');
    });

    it('keeps the <li> wrapper for arrays but escapes each element', () => {
      expect(renderTemplate('<ul>{{items}}</ul>', {items: ['<i>a</i>', 'b']}, html)).toBe(
        '<ul><li>&lt;i&gt;a&lt;/i&gt;</li>\n<li>b</li></ul>',
      );
    });

    it('escapes default values too', () => {
      expect(renderTemplate('{{name ?? Tom & Jerry}}', {}, html)).toBe('Tom &amp; Jerry');
    });
  });

  describe('?? default with empty-string values', () => {
    it('falls back to the default for empty strings', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: ''})).toBe('嗨 朋友，');
    });

    it('falls back to the default for whitespace-only strings', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: '  '})).toBe('嗨 朋友，');
    });

    it('renders empty as-is when no default is given', () => {
      expect(renderTemplate('嗨 {{display_name}}，', {display_name: ''})).toBe('嗨 ，');
    });

    it('does not treat 0 as empty', () => {
      expect(renderTemplate('{{count ?? none}}', {count: 0, data: {count: 0}})).toBe('0');
    });

    it('still prefers a real value over the default', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: '星星'})).toBe('嗨 星星，');
    });
  });
});
