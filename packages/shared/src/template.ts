const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Escape HTML-special characters so a value renders as literal text. The set
 * mirrors Handlebars' escapeExpression: the five classic characters plus
 * backtick and equals, which blunt injection into unquoted attributes.
 * Also neutralizes comment-breaking sequences ("-->" becomes "--&gt;").
 *
 * Escaped values are fully safe in text content and quoted attribute values.
 * Unquoted attribute placements ({{var}} after a bare attr=) are NOT a
 * supported context — whitespace cannot be escaped, so a value can still
 * introduce valueless boolean attributes there. Always quote attributes in
 * templates: href="{{url}}", never href={{url}}.
 *
 * CSS contexts (style="..." attributes and <style> blocks) are likewise NOT a
 * supported context for substituted values — browsers decode entities in
 * attribute values before the CSS parser runs, so no character escaping can
 * neutralize CSS metacharacters there. Keep variables out of CSS entirely.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`=]/g, c => HTML_ESCAPES[c] as string);
}

/**
 * Render email template by replacing variables
 * Supports {{variable}} and {{variable ?? defaultValue}} syntax
 * Also supports nested access like {{data.firstName}}
 *
 * Example:
 * renderTemplate('Hello {{name}}!', { name: 'World' }) -> 'Hello World!'
 * renderTemplate('Hello {{data.name}}!', { data: { name: 'World' } }) -> 'Hello World!'
 * renderTemplate('Hello {{name ?? Guest}}!', {}) -> 'Hello Guest!'
 *
 * Options:
 * - escapeHtml: HTML-escape substituted values (never the template text itself).
 *   Enable when rendering into an HTML context (email bodies, previews) so
 *   user-controlled values like display_name cannot inject markup. Leave off
 *   for plain-text contexts (email subjects are MIME headers, not HTML).
 */
export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
  options?: {escapeHtml?: boolean},
): string {
  const escape = options?.escapeHtml ? escapeHtml : (s: string) => s;

  return template.replace(/\{\{(.*?)\}\}/g, (match, key) => {
    const [mainKey, defaultValue] = key.split('??').map((s: string) => s.trim());

    // Handle nested property access (e.g., data.firstName)
    const getValue = (obj: Record<string, unknown>, path: string): unknown => {
      return path.split('.').reduce((current: Record<string, unknown> | unknown, key) => {
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          return (current as Record<string, unknown>)[key];
        }
        return undefined;
      }, obj);
    };

    // Try multiple lookup strategies
    const value =
      getValue(variables, mainKey) || // Try as nested path (e.g., data.firstName)
      variables[mainKey] || // Try as top-level property
      (variables.data as Record<string, unknown>)?.[mainKey]; // Try in data object

    // Handle array values (for lists) — the <li> wrapper is intentional template
    // output, but each element is data and gets escaped like any other value
    if (Array.isArray(value)) {
      return value.map((e: string) => `<li>${escape(String(e))}</li>`).join('\n');
    }

    let resolved = value ?? defaultValue ?? '';

    // `??` also falls back on blank strings. Two shapes reach this branch: ''
    // stored under the data object (the third lookup returns it verbatim — the
    // || chain only skips falsy values in EARLIER lookups) and whitespace-only
    // strings (truthy, so even the first lookup returns them). Both otherwise
    // render greetings like "Hi ,". A top-level-only '' never gets here — the
    // || chain yields undefined and the ?? above already applies the default.
    if (typeof resolved === 'string' && resolved.trim() === '' && defaultValue !== undefined) {
      resolved = defaultValue;
    }

    return escape(String(resolved));
  });
}
