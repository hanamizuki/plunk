import {describe, expect, it} from 'vitest';
import {escapeHtml, renderTemplate} from '../template';

describe('escapeHtml', () => {
  it('escapes the HTML-special characters (Handlebars set)', () => {
    expect(escapeHtml('&<>"\'`=')).toBe('&amp;&lt;&gt;&quot;&#39;&#x60;&#x3D;');
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

  it('renders numbers, including a top-level 0', () => {
    // Send paths pass contact data both spread at top level and under `data`
    expect(renderTemplate('{{bonus_days}} days', {bonus_days: 0, data: {bonus_days: 0}})).toBe('0 days');
    expect(renderTemplate('{{bonus_days}} days', {bonus_days: 0})).toBe('0 days');
    expect(renderTemplate('{{bonus_days}} days', {bonus_days: 7})).toBe('7 days');
  });

  it('keeps falsy values resolved through a dotted path', () => {
    // Only the nested lookup can match a dotted key, so a falsy value here has
    // no fallback — it must survive the lookup chain rather than render empty.
    // Webhook bodies (`{{event.count}}`, `{{data.active}}`) depend on this, and
    // CSV import now stores real booleans/numbers instead of strings.
    expect(renderTemplate('{{data.active}}', {data: {active: false}})).toBe('false');
    expect(renderTemplate('{{event.count}}', {event: {count: 0}})).toBe('0');
    expect(renderTemplate('{{data.active ?? unknown}}', {data: {active: false}})).toBe('false');
    // A genuinely missing path still falls back to the default
    expect(renderTemplate('{{data.missing ?? none}}', {data: {}})).toBe('none');
  });

  describe('without escapeHtml (plain-text contexts like subjects)', () => {
    it('substitutes values verbatim', () => {
      expect(renderTemplate('Hi {{name}}', {name: '<b>Ada & Eve</b>'})).toBe('Hi <b>Ada & Eve</b>');
    });

    it('joins array values with ", " — no <li> markup or newlines', () => {
      // Newlines would make undici reject the value as a webhook header
      expect(renderTemplate('Tags: {{items}}', {items: ['a', 'b']})).toBe('Tags: a, b');
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

    it('keeps URLs usable in quoted href attributes', () => {
      // `=` is entity-escaped, and browsers decode entities in quoted attribute
      // values before URL resolution, so the link still targets ?token=abc123
      const rendered = renderTemplate('<a href="{{gift_url}}">', {gift_url: 'https://x.tw/gift?token=abc123'}, html);
      expect(rendered).toBe('<a href="https://x.tw/gift?token&#x3D;abc123">');
    });

    it('cannot bind attribute values in unquoted attribute placements', () => {
      // Unquoted attributes are unsupported (whitespace splits), but escaping
      // `=` keeps an injected token from carrying a value like a handler
      expect(renderTemplate('<div title={{v}}>', {v: 'x onfocus=alert(1)'}, html)).toBe(
        '<div title=x onfocus&#x3D;alert(1)>',
      );
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
    // Send paths pass contact data both spread at top level and under `data`
    // (the production shape). The lookup chain is `??`, so an empty string is
    // returned verbatim by the first matching lookup and the blank-string
    // branch is what applies the default.
    it('falls back to the default for empty strings (production shape)', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: '', data: {display_name: ''}})).toBe(
        '嗨 朋友，',
      );
    });

    it('falls back to the default for top-level-only empty strings', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: ''})).toBe('嗨 朋友，');
    });

    it('falls back to the default for whitespace-only strings', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: '  ', data: {display_name: '  '}})).toBe(
        '嗨 朋友，',
      );
    });

    it('renders empty as-is when no default is given', () => {
      expect(renderTemplate('嗨 {{display_name}}，', {display_name: '', data: {display_name: ''}})).toBe('嗨 ，');
    });

    it('does not treat 0 as empty', () => {
      expect(renderTemplate('{{count ?? none}}', {count: 0, data: {count: 0}})).toBe('0');
    });

    it('still prefers a real value over the default', () => {
      expect(renderTemplate('嗨 {{display_name ?? 朋友}}，', {display_name: '星星'})).toBe('嗨 星星，');
    });
  });
});
