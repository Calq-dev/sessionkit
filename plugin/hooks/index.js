// sessionkit's function hooks: a plugin names one module, so this one registers them all.
import { register as agent } from "./agent.js";
import { register as architect } from "./architect.js";
import { register as awareness } from "./awareness.js";
import { register as compact } from "./compact.js";
import { register as edit } from "./edit.js";
import { register as effort } from "./effort.js";
import { register as fold } from "./fold.js";
import { register as prompt } from "./prompt.js";
import { register as read } from "./read.js";
import { register as repeat } from "./repeat.js";

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  agent(on, options);
  architect(on, options);
  awareness(on, options);
  compact(on, options);
  edit(on, options);
  effort(on, options);
  fold(on, options);
  prompt(on, options);
  read(on, options);
  repeat(on, options);
};
