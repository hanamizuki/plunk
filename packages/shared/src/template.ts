const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape the five HTML-special characters so a value renders as literal text.
 * Used for template variable substitution into HTML bodies; also neutralizes
 * comment-breaking sequences ("-->" becomes "--&gt;").
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => HTML_ESCAPES[c] as string);
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

    // `??` also falls back on empty/whitespace-only strings: contact data often
    // stores '' for unset fields, and a blank display_name must render the
    // default instead of producing greetings like "Hi ,"
    if (typeof resolved === 'string' && resolved.trim() === '' && defaultValue !== undefined) {
      resolved = defaultValue;
    }

    return escape(String(resolved));
  });
}
