"use strict";
const path = require("path");
const { helper } = require("./helper");

/** Join two segments. */
export function join(a, b) {
  return path.join(a, helper(b));
}

export let counter = 0;
