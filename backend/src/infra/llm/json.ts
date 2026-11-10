/**
 * Helpers for turning free-form LLM output into JSON.
 */

/**
 * Extract the first JSON array (or object, wrapped into an array) from an LLM
 * response. Handles markdown code fences and leading/trailing prose.
 */
export function extractJsonArray(content: string): any[] {
  const text = content.trim();
  const candidates: string[] = [];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(text);

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['testCases', 'test_cases', 'tests', 'items']) {
          if (Array.isArray((parsed as any)[key])) return (parsed as any)[key];
        }
        return [parsed];
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error('The AI response did not contain valid JSON. Please try again.');
}
