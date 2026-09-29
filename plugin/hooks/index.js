// sessionkit's function hooks: a plugin names one module, so this one registers both.
import { register as compact } from "./compact.js";
import { register as prompt } from "./prompt.js";

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  compact(on, options);
  prompt(on, options);
};
