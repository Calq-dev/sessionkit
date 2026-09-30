// sessionkit's function hooks: a plugin names one module, so this one registers them all.
import { register as agent } from "./agent.js";
import { register as compact } from "./compact.js";
import { register as edit } from "./edit.js";
import { register as prompt } from "./prompt.js";
import { register as read } from "./read.js";

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  agent(on, options);
  compact(on, options);
  edit(on, options);
  prompt(on, options);
  read(on, options);
};
