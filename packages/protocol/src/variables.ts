export type VariableType = "number" | "text";

// Value is always carried as a string on the wire/in storage (a numeric
// variable is still just digits) -- `type` is purely a UI/authoring hint
// (numeric stepper vs. free text) and doesn't change how interpolation
// works, since {key} substitution is always a plain string replace.
export interface Variable {
  key: string;
  type: VariableType;
  value: string;
  createdAt: string;
}

// Lets a Text asset reference a room variable by wrapping its key in curly
// braces (e.g. "Kills: {codkills}") so a streamer can update one shared
// number/word without editing every text object that mentions it.
// Unmatched keys are left as-is (literal "{whatever}") rather than blanked
// out, so a typo'd or since-deleted variable is obviously wrong rather than
// silently vanishing.
export function interpolateText(text: string, variables: Record<string, Variable>): string {
  return text.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const variable = variables[key];
    return variable ? variable.value : match;
  });
}
