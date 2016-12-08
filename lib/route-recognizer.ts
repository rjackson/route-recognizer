import map from "./route-recognizer/dsl";
import { normalizePath, normalizeSegment, encodePathSegment } from "./route-recognizer/normalizer";

const specials = [
  "/", ".", "*", "+", "?", "|",
  "(", ")", "[", "]", "{", "}", "\\"
];

const escapeRegex = new RegExp("(\\" + specials.join("|\\") + ")", "g");

const isArray = Array.isArray || function isArray(value: any[]): value is Array<any> {
  return Object.prototype.toString.call(value) === "[object Array]";
};

function getParam(params: Params | null | undefined, key: string): string {
  if (typeof params !== "object" || params === null) {
    throw new Error("You must pass an object as the second argument to `generate`.");
  }

  if (!params.hasOwnProperty(key)) {
    throw new Error("You must provide param `" + key + "` to `generate`.");
  }

  let value = params[key];
  let str = typeof value === "string" ? value : "" + value;
  if (str.length === 0) {
    throw new Error("You must provide a param `" + key + "`.");
  }
  return str;
}

const enum SegmentType {
  Static,
  Dynamic,
  Star,
  Epsilon
}

// A Segment represents a segment in the original route description.
// Each Segment type provides an `eachChar` and `regex` method.
//
// The `eachChar` method invokes the callback with one or more character
// specifications. A character specification consumes one or more input
// characters.
//
// The `regex` method returns a regex fragment for the segment. If the
// segment is a dynamic of star segment, the regex fragment also includes
// a capture.
//
// A character specification contains:
//
// * `validChars`: a String with a list of all valid characters, or
// * `invalidChars`: a String with a list of all invalid characters
// * `repeat`: true if the character specification can repeat
class StaticSegment {
  type: SegmentType.Static;
  string: string;

  constructor(str: string) {
    this.string = normalizeSegment(str);
  }

  eachChar(currentState) {
    let str = this.string, ch;

    for (let i = 0; i < str.length; i++) {
      ch = str.charAt(i);
      currentState = currentState.put({ invalidChars: undefined, repeat: false, validChars: ch });
    }

    return currentState;
  }

  regex() {
    return this.string.replace(escapeRegex, "\\$1");
  }

  generate(params?: Params | null) {
    return this.string;
  }
}

class DynamicSegment {
  type: SegmentType.Dynamic;
  name: string;
  constructor(name: string) {
    this.name = normalizeSegment(name);
  }

  eachChar(currentState) {
    return currentState.put({ invalidChars: "/", repeat: true, validChars: undefined });
  }

  regex() {
    return "([^/]+)";
  }

  generate(params?: Params | null) {
    let value = getParam(params, this.name);
    if (RouteRecognizer.ENCODE_AND_DECODE_PATH_SEGMENTS) {
      return encodePathSegment(value);
    } else {
      return value;
    }
  }
}

class StarSegment {
  type: SegmentType.Star;
  constructor(public name: string) {}

  eachChar(currentState) {
    return currentState.put({
      invalidChars: "",
      repeat: true,
      validChars: undefined
    });
  }

  regex() {
    return "(.+)";
  }

  generate(params?: Params | null): string {
    return getParam(params, this.name);
  }
}

class EpsilonSegment {
  type: SegmentType.Epsilon;
  eachChar(currentState) {
    return currentState;
  }
  regex(): string {
    return "";
  }
  generate(): string {
    return "";
  }
}

export interface Params {
  [key: string]: string[] | string | undefined;
  queryParams?: string[];
}


type Segment = StaticSegment | DynamicSegment | StarSegment | EpsilonSegment;

// The `names` will be populated with the paramter name for each dynamic/star
// segment. `shouldDecodes` will be populated with a boolean for each dyanamic/star
// segment, indicating whether it should be decoded during recognition.
function parse(route, names, types, shouldDecodes): Segment[] {
  // normalize route as not starting with a "/". Recognition will
  // also normalize.
  if (route.charAt(0) === "/") { route = route.substr(1); }

  let segments = route.split("/");
  let results = new Array(segments.length);

  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i], match;

    if (match = segment.match(/^:([^\/]+)$/)) {
      results[i] = new DynamicSegment(match[1]);
      names.push(match[1]);
      shouldDecodes.push(true);
      types.dynamics++;
    } else if (match = segment.match(/^\*([^\/]+)$/)) {
      results[i] = new StarSegment(match[1]);
      names.push(match[1]);
      shouldDecodes.push(false);
      types.stars++;
    } else if (segment === "") {
      results[i] = new EpsilonSegment();
    } else {
      results[i] = new StaticSegment(segment);
      types.statics++;
    }
  }

  return results;
}

function isEqualCharSpec(specA, specB) {
  return specA.validChars === specB.validChars &&
         specA.invalidChars === specB.invalidChars;
}

// A State has a character specification and (`charSpec`) and a list of possible
// subsequent states (`nextStates`).
//
// If a State is an accepting state, it will also have several additional
// properties:
//
// * `regex`: A regular expression that is used to extract parameters from paths
//   that reached this accepting state.
// * `handlers`: Information on how to convert the list of captures into calls
//   to registered handlers with the specified parameters
// * `types`: How many static, dynamic or star segments in this route. Used to
//   decide which route to use if multiple registered routes match a path.
//
// Currently, State is implemented naively by looping over `nextStates` and
// comparing a character specification against a character. A more efficient
// implementation would use a hash of keys pointing at one or more next states.

class State {
  nextStates: any;
  charSpec: any;
  regex: any;
  handlers: any;
  specificity: any;
  types: any;

  constructor (charSpec?: any) {
    this.charSpec = charSpec;
    this.nextStates = [];
    this.regex = undefined;
    this.handlers = undefined;
    this.specificity = undefined;
  }

  get(charSpec) {
    let nextStates = this.nextStates;

    for (let i = 0; i < nextStates.length; i++) {
      let child = nextStates[i];

      if (isEqualCharSpec(child.charSpec, charSpec)) {
        return child;
      }
    }
  }

  put(charSpec) {
    let state;

    // If the character specification already exists in a child of the current
    // state, just return that state.
    if (state = this.get(charSpec)) { return state; }

    // Make a new state for the character spec
    state = new State(charSpec);

    // Insert the new state as a child of the current state
    this.nextStates.push(state);

    // If this character specification repeats, insert the new state as a child
    // of itself. Note that this will not trigger an infinite loop because each
    // transition during recognition consumes a character.
    if (charSpec.repeat) {
      state.nextStates.push(state);
    }

    // Return the new state
    return state;
  }

  // Find a list of child states matching the next character
  match(ch) {
    let nextStates = this.nextStates,
        child, charSpec, chars;

    let returned: any[] = [];

    for (let i = 0; i < nextStates.length; i++) {
      child = nextStates[i];

      charSpec = child.charSpec;

      if (typeof (chars = charSpec.validChars) !== "undefined") {
        if (chars.indexOf(ch) !== -1) { returned.push(child); }
      } else if (typeof (chars = charSpec.invalidChars) !== "undefined") {
        if (chars.indexOf(ch) === -1) { returned.push(child); }
      }
    }

    return returned;
  }
}

// This is a somewhat naive strategy, but should work in a lot of cases
// A better strategy would properly resolve /posts/:id/new and /posts/edit/:id.
//
// This strategy generally prefers more static and less dynamic matching.
// Specifically, it
//
//  * prefers fewer stars to more, then
//  * prefers using stars for less of the match to more, then
//  * prefers fewer dynamic segments to more, then
//  * prefers more static segments to more
function sortSolutions(states) {
  return states.sort(function(a, b) {
    if (a.types.stars !== b.types.stars) { return a.types.stars - b.types.stars; }

    if (a.types.stars) {
      if (a.types.statics !== b.types.statics) { return b.types.statics - a.types.statics; }
      if (a.types.dynamics !== b.types.dynamics) { return b.types.dynamics - a.types.dynamics; }
    }

    if (a.types.dynamics !== b.types.dynamics) { return a.types.dynamics - b.types.dynamics; }
    if (a.types.statics !== b.types.statics) { return b.types.statics - a.types.statics; }

    return 0;
  });
}

function recognizeChar(states, ch) {
  let nextStates = [];

  for (let i = 0, l = states.length; i < l; i++) {
    let state = states[i];

    nextStates = nextStates.concat(state.match(ch));
  }

  return nextStates;
}

let oCreate = Object.create || function(proto) {
  function F() {}
  F.prototype = proto;
  return new F();
};

function RecognizeResults(queryParams) {
  this.queryParams = queryParams || {};
}
RecognizeResults.prototype = oCreate({
  splice: Array.prototype.splice,
  slice:  Array.prototype.slice,
  push:   Array.prototype.push,
  length: 0,
  queryParams: null
});

function findHandler(state, originalPath, queryParams) {
  let handlers = state.handlers, regex = state.regex;
  let captures = originalPath.match(regex), currentCapture = 1;
  let result = new RecognizeResults(queryParams);

  result.length = handlers.length;

  for (let i = 0; i < handlers.length; i++) {
    let handler = handlers[i], names = handler.names,
      shouldDecodes = handler.shouldDecodes, params = {};
    let name, shouldDecode, capture;

    for (let j = 0; j < names.length; j++) {
      name = names[j];
      shouldDecode = shouldDecodes[j];
      capture = captures[currentCapture++];

      if (RouteRecognizer.ENCODE_AND_DECODE_PATH_SEGMENTS) {
        if (shouldDecode) {
          params[name] = decodeURIComponent(capture);
        } else {
          params[name] = capture;
        }
      } else {
        params[name] = capture;
      }
    }

    result[i] = { handler: handler.handler, params: params, isDynamic: !!names.length };
  }

  return result;
}

function decodeQueryParamPart(part) {
  // http://www.w3.org/TR/html401/interact/forms.html#h-17.13.4.1
  part = part.replace(/\+/gm, "%20");
  let result;
  try {
    result = decodeURIComponent(part);
  } catch (error) {result = ""; }
  return result;
}

export interface Route {
  path: string;
  handler: any;
  queryParams?: string[];
}

interface NamedRoute {
  segments: Segment[];
  handlers: any[];
}

// The main interface

class RouteRecognizer {
  private rootState: State;
  private names: {
    [name: string]: NamedRoute;
  };
  map = map;

  delegate: {
    contextEntered?: (this: undefined, target, match) => void;
    willAddRoute?: (this: undefined, context, route) => void;
  } | undefined;

  static VERSION = "VERSION_STRING_PLACEHOLDER";
  // Set to false to opt-out of encoding and decoding path segments.
  // See https://github.com/tildeio/route-recognizer/pull/55
  static ENCODE_AND_DECODE_PATH_SEGMENTS = true;
  static Normalizer = {
    normalizeSegment, normalizePath, encodePathSegment
  };

  constructor() {
    this.rootState = new State();
    this.names = {};
  }

  add(routes: Route[], options?: { as: string }) {
    let currentState = this.rootState;
    let regex = "^";
    let types = { statics: 0, dynamics: 0, stars: 0 };
    let handlers: any[] = new Array(routes.length);
    let allSegments: Segment[] = [];
    let name: string | undefined;

    let isEmpty = true;

    for (let i = 0; i < routes.length; i++) {
      let route = routes[i], names = [], shouldDecodes = [];

      let segments = parse(route.path, names, types, shouldDecodes);

      allSegments = allSegments.concat(segments);

      for (let j = 0; j < segments.length; j++) {
        let segment = segments[j];

        if (segment instanceof EpsilonSegment) { continue; }

        isEmpty = false;

        // Add a "/" for the new segment
        currentState = currentState.put({ invalidChars: undefined, repeat: false, validChars: "/" });
        regex += "/";

        // Add a representation of the segment to the NFA and regex
        currentState = segment.eachChar(currentState);
        regex += segment.regex();
      }
      let handler = { handler: route.handler, names: names, shouldDecodes: shouldDecodes };
      handlers[i] = handler;
    }

    if (isEmpty) {
      currentState = currentState.put({ invalidChars: undefined, repeat: false, validChars: "/" });
      regex += "/";
    }

    currentState.handlers = handlers;
    currentState.regex = new RegExp(regex + "$");
    currentState.types = types;

    if (typeof options === "object" && options !== null && options.hasOwnProperty("as")) {
      name = options.as;
    }

    if (name && this.names.hasOwnProperty(name)) {
      throw new Error("You may not add a duplicate route named `" + name + "`.");
    }

    if (name = options && options.as) {
      this.names[name] = {
        segments: allSegments,
        handlers: handlers
      };
    }
  }

  handlersFor(name) {
    let route = this.names[name];

    if (!route) { throw new Error("There is no route named " + name); }

    let result = new Array(route.handlers.length);

    for (let i = 0; i < route.handlers.length; i++) {
      result[i] = route.handlers[i];
    }

    return result;
  }

  hasRoute(name) {
    return !!this.names[name];
  }

  generate(name, params?: Params | null) {
    let route = this.names[name];
    let output = "";
    if (!route) { throw new Error("There is no route named " + name); }

    let segments: Segment[] = route.segments;

    for (let i = 0; i < segments.length; i++) {
      let segment: Segment = segments[i];

      if (segment instanceof EpsilonSegment) {
        continue;
      }

      output += "/";
      output += segment.generate(params);
    }

    if (output.charAt(0) !== "/") { output = "/" + output; }

    if (params && params.queryParams) {
      output += this.generateQueryString(params.queryParams, route.handlers);
    }

    return output;
  }

  generateQueryString(params, handlers: any) {
    let pairs: any[] = [];
    let keys: any[] = [];
    for (let key in params) {
      if (params.hasOwnProperty(key)) {
        keys.push(key);
      }
    }
    keys.sort();
    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      let value = params[key];
      if (value == null) {
        continue;
      }
      let pair = encodeURIComponent(key);
      if (isArray(value)) {
        for (let j = 0; j < value.length; j++) {
          let arrayPair = key + "[]" + "=" + encodeURIComponent(value[j]);
          pairs.push(arrayPair);
        }
      } else {
        pair += "=" + encodeURIComponent(value);
        pairs.push(pair);
      }
    }

    if (pairs.length === 0) { return ""; }

    return "?" + pairs.join("&");
  }

  parseQueryString(queryString) {
    let pairs = queryString.split("&"), queryParams = {};
    for (let i = 0; i < pairs.length; i++) {
      let pair      = pairs[i].split("="),
          key       = decodeQueryParamPart(pair[0]),
          keyLength = key.length,
          isArray = false,
          value;
      if (pair.length === 1) {
        value = "true";
      } else {
        // Handle arrays
        if (keyLength > 2 && key.slice(keyLength - 2) === "[]") {
          isArray = true;
          key = key.slice(0, keyLength - 2);
          if (!queryParams[key]) {
            queryParams[key] = [];
          }
        }
        value = pair[1] ? decodeQueryParamPart(pair[1]) : "";
      }
      if (isArray) {
        queryParams[key].push(value);
      } else {
        queryParams[key] = value;
      }
    }
    return queryParams;
  }

  recognize(path) {
    let states: any[] = [ this.rootState ],
        pathLen, i, queryStart, queryParams = {},
        hashStart,
        isSlashDropped = false;

    hashStart = path.indexOf("#");
    if (hashStart !== -1) {
      path = path.substr(0, hashStart);
    }

    queryStart = path.indexOf("?");
    if (queryStart !== -1) {
      let queryString = path.substr(queryStart + 1, path.length);
      path = path.substr(0, queryStart);
      queryParams = this.parseQueryString(queryString);
    }

    if (path.charAt(0) !== "/") { path = "/" + path; }
    let originalPath = path;

    if (RouteRecognizer.ENCODE_AND_DECODE_PATH_SEGMENTS) {
      path = normalizePath(path);
    } else {
      path = decodeURI(path);
      originalPath = decodeURI(originalPath);
    }

    pathLen = path.length;
    if (pathLen > 1 && path.charAt(pathLen - 1) === "/") {
      path = path.substr(0, pathLen - 1);
      originalPath = originalPath.substr(0, originalPath.length - 1);
      isSlashDropped = true;
    }

    for (i = 0; i < path.length; i++) {
      states = recognizeChar(states, path.charAt(i));
      if (!states.length) { break; }
    }

    let solutions: any = [];
    for (i = 0; i < states.length; i++) {
      if (states[i].handlers) { solutions.push(states[i]); }
    }

    states = sortSolutions(solutions);

    let state = solutions[0];

    if (state && state.handlers) {
      // if a trailing slash was dropped and a star segment is the last segment
      // specified, put the trailing slash back
      if (isSlashDropped && state.regex.source.slice(-5) === "(.+)$") {
         originalPath = originalPath + "/";
       }
      return findHandler(state, originalPath, queryParams);
    }
  }
}

export default RouteRecognizer;
