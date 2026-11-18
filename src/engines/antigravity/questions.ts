/** Antigravity uses JSON Schema oneOf constants for choice IDs and a sibling *_other for free text. */
export function formQuestions(params: Record<string, any>) {
  const fields: Record<string, any> = params.requestedSchema?.properties ?? {};
  const keys = Object.keys(fields).filter((key) => !key.endsWith('_other') || !fields[key.slice(0, -6)]);
  return keys.map((key, index) => {
    const field = fields[key];
    const choices =
      field.oneOf?.map((item: any) => ({ label: String(item.title ?? item.const) })) ??
      field.enum?.map((item: unknown) => ({ label: String(item) })) ??
      (field.type === 'boolean' ? [{ label: 'true' }, { label: 'false' }] : []);
    const title = field.title || field.description || key;
    return {
      question: index === 0 && params.message ? `${params.message}\n${title}` : title,
      header: key.slice(0, 12),
      options: choices,
      multiSelect: false,
    };
  });
}
export function formAnswer(
  params: Record<string, any>,
  answers: Record<string, string>,
): Record<string, unknown> | undefined {
  const fields: Record<string, any> = params.requestedSchema?.properties ?? {};
  const keys = Object.keys(fields).filter((key) => !key.endsWith('_other') || !fields[key.slice(0, -6)]);
  const values = Object.values(answers);
  const content: Record<string, unknown> = {};
  for (const [index, key] of keys.entries()) {
    const field = fields[key];
    const title = field.title || field.description || key;
    const value = answers[title] ?? answers[`${params.message}\n${title}`] ?? answers[key] ?? values[index];
    if (value === undefined || /^(?:\[Skipped\]|\[Timed out\])$/i.test(value)) return undefined;
    if (Array.isArray(field.oneOf)) {
      const choice = field.oneOf.find(
        (item: any) => String(item.title ?? item.const) === value || String(item.const) === value,
      );
      if (choice) content[key] = choice.const;
      else if (fields[`${key}_other`]) content[`${key}_other`] = value;
      else return undefined;
    } else {
      if (field.type === 'boolean' && !['true', 'false'].includes(value)) return undefined;
      const parsed =
        field.type === 'boolean'
          ? value === 'true'
          : ['number', 'integer'].includes(field.type)
            ? Number(value)
            : value;
      if (
        (field.enum && !field.enum.includes(parsed)) ||
        (typeof parsed === 'number' &&
          (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))))
      )
        return undefined;
      content[key] = parsed;
    }
  }
  if ((params.requestedSchema?.required ?? []).some((key: string) => !(key in content))) return undefined;
  return content;
}
