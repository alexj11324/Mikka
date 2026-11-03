var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/constants.js
var require_constants = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/constants.js"(exports, module) {
    "use strict";
    var SEMVER_SPEC_VERSION = "2.0.0";
    var MAX_LENGTH = 256;
    var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || /* istanbul ignore next */
    9007199254740991;
    var MAX_SAFE_COMPONENT_LENGTH = 16;
    var MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
    var RELEASE_TYPES = [
      "major",
      "premajor",
      "minor",
      "preminor",
      "patch",
      "prepatch",
      "prerelease"
    ];
    module.exports = {
      MAX_LENGTH,
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_SAFE_INTEGER,
      RELEASE_TYPES,
      SEMVER_SPEC_VERSION,
      FLAG_INCLUDE_PRERELEASE: 1,
      FLAG_LOOSE: 2
    };
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/debug.js
var require_debug = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/debug.js"(exports, module) {
    "use strict";
    var debug = typeof process === "object" && process.env && process.env.NODE_DEBUG && /\bsemver\b/i.test(process.env.NODE_DEBUG) ? (...args) => console.error("SEMVER", ...args) : () => {
    };
    module.exports = debug;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/re.js
var require_re = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/re.js"(exports, module) {
    "use strict";
    var {
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_LENGTH
    } = require_constants();
    var debug = require_debug();
    exports = module.exports = {};
    var re = exports.re = [];
    var safeRe = exports.safeRe = [];
    var src = exports.src = [];
    var safeSrc = exports.safeSrc = [];
    var t = exports.t = {};
    var R = 0;
    var LETTERDASHNUMBER = "[a-zA-Z0-9-]";
    var safeRegexReplacements = [
      ["\\s", 1],
      ["\\d", MAX_LENGTH],
      [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH]
    ];
    var makeSafeRegex = (value) => {
      for (const [token, max] of safeRegexReplacements) {
        value = value.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
      }
      return value;
    };
    var createToken = (name, value, isGlobal) => {
      const safe = makeSafeRegex(value);
      const index = R++;
      debug(name, index, value);
      t[name] = index;
      src[index] = value;
      safeSrc[index] = safe;
      re[index] = new RegExp(value, isGlobal ? "g" : void 0);
      safeRe[index] = new RegExp(safe, isGlobal ? "g" : void 0);
    };
    createToken("NUMERICIDENTIFIER", "0|[1-9]\\d*");
    createToken("NUMERICIDENTIFIERLOOSE", "\\d+");
    createToken("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
    createToken("MAINVERSION", `(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})`);
    createToken("MAINVERSIONLOOSE", `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASEIDENTIFIER", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIER]})`);
    createToken("PRERELEASEIDENTIFIERLOOSE", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASE", `(?:-(${src[t.PRERELEASEIDENTIFIER]}(?:\\.${src[t.PRERELEASEIDENTIFIER]})*))`);
    createToken("PRERELEASELOOSE", `(?:-?(${src[t.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${src[t.PRERELEASEIDENTIFIERLOOSE]})*))`);
    createToken("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
    createToken("BUILD", `(?:\\+(${src[t.BUILDIDENTIFIER]}(?:\\.${src[t.BUILDIDENTIFIER]})*))`);
    createToken("FULLPLAIN", `v?${src[t.MAINVERSION]}${src[t.PRERELEASE]}?${src[t.BUILD]}?`);
    createToken("FULL", `^${src[t.FULLPLAIN]}$`);
    createToken("LOOSEPLAIN", `[v=\\s]*${src[t.MAINVERSIONLOOSE]}${src[t.PRERELEASELOOSE]}?${src[t.BUILD]}?`);
    createToken("LOOSE", `^${src[t.LOOSEPLAIN]}$`);
    createToken("GTLT", "((?:<|>)?=?)");
    createToken("XRANGEIDENTIFIERLOOSE", `${src[t.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`);
    createToken("XRANGEIDENTIFIER", `${src[t.NUMERICIDENTIFIER]}|x|X|\\*`);
    createToken("XRANGEPLAIN", `[v=\\s]*(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:${src[t.PRERELEASE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGEPLAINLOOSE", `[v=\\s]*(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:${src[t.PRERELEASELOOSE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAIN]}$`);
    createToken("XRANGELOOSE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COERCEPLAIN", `${"(^|[^\\d])(\\d{1,"}${MAX_SAFE_COMPONENT_LENGTH}})(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`);
    createToken("COERCE", `${src[t.COERCEPLAIN]}(?:$|[^\\d])`);
    createToken("COERCEFULL", src[t.COERCEPLAIN] + `(?:${src[t.PRERELEASE]})?(?:${src[t.BUILD]})?(?:$|[^\\d])`);
    createToken("COERCERTL", src[t.COERCE], true);
    createToken("COERCERTLFULL", src[t.COERCEFULL], true);
    createToken("LONETILDE", "(?:~>?)");
    createToken("TILDETRIM", `(\\s*)${src[t.LONETILDE]}\\s+`, true);
    exports.tildeTrimReplace = "$1~";
    createToken("TILDE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAIN]}$`);
    createToken("TILDELOOSE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("LONECARET", "(?:\\^)");
    createToken("CARETTRIM", `(\\s*)${src[t.LONECARET]}\\s+`, true);
    exports.caretTrimReplace = "$1^";
    createToken("CARET", `^${src[t.LONECARET]}${src[t.XRANGEPLAIN]}$`);
    createToken("CARETLOOSE", `^${src[t.LONECARET]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COMPARATORLOOSE", `^${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]})$|^$`);
    createToken("COMPARATOR", `^${src[t.GTLT]}\\s*(${src[t.FULLPLAIN]})$|^$`);
    createToken("COMPARATORTRIM", `(\\s*)${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]}|${src[t.XRANGEPLAIN]})`, true);
    exports.comparatorTrimReplace = "$1$2$3";
    createToken("HYPHENRANGE", `^\\s*(${src[t.XRANGEPLAIN]})\\s+-\\s+(${src[t.XRANGEPLAIN]})\\s*$`);
    createToken("HYPHENRANGELOOSE", `^\\s*(${src[t.XRANGEPLAINLOOSE]})\\s+-\\s+(${src[t.XRANGEPLAINLOOSE]})\\s*$`);
    createToken("STAR", "(<|>)?=?\\s*\\*");
    createToken("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");
    createToken("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/parse-options.js
var require_parse_options = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/parse-options.js"(exports, module) {
    "use strict";
    var looseOption = Object.freeze({ loose: true });
    var emptyOpts = Object.freeze({});
    var parseOptions = (options) => {
      if (!options) {
        return emptyOpts;
      }
      if (typeof options !== "object") {
        return looseOption;
      }
      return options;
    };
    module.exports = parseOptions;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/identifiers.js
var require_identifiers = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/identifiers.js"(exports, module) {
    "use strict";
    var numeric = /^[0-9]+$/;
    var compareIdentifiers = (a, b) => {
      if (typeof a === "number" && typeof b === "number") {
        return a === b ? 0 : a < b ? -1 : 1;
      }
      const anum = numeric.test(a);
      const bnum = numeric.test(b);
      if (anum && bnum) {
        a = +a;
        b = +b;
      }
      return a === b ? 0 : anum && !bnum ? -1 : bnum && !anum ? 1 : a < b ? -1 : 1;
    };
    var rcompareIdentifiers = (a, b) => compareIdentifiers(b, a);
    module.exports = {
      compareIdentifiers,
      rcompareIdentifiers
    };
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/semver.js
var require_semver = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/semver.js"(exports, module) {
    "use strict";
    var debug = require_debug();
    var { MAX_LENGTH, MAX_SAFE_INTEGER } = require_constants();
    var { safeRe: re, t } = require_re();
    var parseOptions = require_parse_options();
    var { compareIdentifiers } = require_identifiers();
    var isPrereleaseIdentifier = (prerelease, identifier) => {
      const identifiers = identifier.split(".");
      if (identifiers.length > prerelease.length) {
        return false;
      }
      for (let i = 0; i < identifiers.length; i++) {
        if (compareIdentifiers(prerelease[i], identifiers[i]) !== 0) {
          return false;
        }
      }
      return true;
    };
    var SemVer = class _SemVer {
      constructor(version, options) {
        options = parseOptions(options);
        if (version instanceof _SemVer) {
          if (version.loose === !!options.loose && version.includePrerelease === !!options.includePrerelease) {
            return version;
          } else {
            version = version.version;
          }
        } else if (typeof version !== "string") {
          throw new TypeError(`Invalid version. Must be a string. Got type "${typeof version}".`);
        }
        if (version.length > MAX_LENGTH) {
          throw new TypeError(
            `version is longer than ${MAX_LENGTH} characters`
          );
        }
        debug("SemVer", version, options);
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        const m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL]);
        if (!m) {
          throw new TypeError(`Invalid Version: ${version}`);
        }
        this.raw = version;
        this.major = +m[1];
        this.minor = +m[2];
        this.patch = +m[3];
        if (this.major > MAX_SAFE_INTEGER || this.major < 0) {
          throw new TypeError("Invalid major version");
        }
        if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) {
          throw new TypeError("Invalid minor version");
        }
        if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) {
          throw new TypeError("Invalid patch version");
        }
        if (!m[4]) {
          this.prerelease = [];
        } else {
          this.prerelease = m[4].split(".").map((id4) => {
            if (/^[0-9]+$/.test(id4)) {
              const num = +id4;
              if (num >= 0 && num < MAX_SAFE_INTEGER) {
                return num;
              }
            }
            return id4;
          });
        }
        this.build = m[5] ? m[5].split(".") : [];
        this.format();
      }
      format() {
        this.version = `${this.major}.${this.minor}.${this.patch}`;
        if (this.prerelease.length) {
          this.version += `-${this.prerelease.join(".")}`;
        }
        return this.version;
      }
      toString() {
        return this.version;
      }
      compare(other) {
        debug("SemVer.compare", this.version, this.options, other);
        if (!(other instanceof _SemVer)) {
          if (typeof other === "string" && other === this.version) {
            return 0;
          }
          other = new _SemVer(other, this.options);
        }
        if (other.version === this.version) {
          return 0;
        }
        return this.compareMain(other) || this.comparePre(other);
      }
      compareMain(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.major < other.major) {
          return -1;
        }
        if (this.major > other.major) {
          return 1;
        }
        if (this.minor < other.minor) {
          return -1;
        }
        if (this.minor > other.minor) {
          return 1;
        }
        if (this.patch < other.patch) {
          return -1;
        }
        if (this.patch > other.patch) {
          return 1;
        }
        return 0;
      }
      comparePre(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.prerelease.length && !other.prerelease.length) {
          return -1;
        } else if (!this.prerelease.length && other.prerelease.length) {
          return 1;
        } else if (!this.prerelease.length && !other.prerelease.length) {
          return 0;
        }
        let i = 0;
        do {
          const a = this.prerelease[i];
          const b = other.prerelease[i];
          debug("prerelease compare", i, a, b);
          if (a === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a === void 0) {
            return -1;
          } else if (a === b) {
            continue;
          } else {
            return compareIdentifiers(a, b);
          }
        } while (++i);
      }
      compareBuild(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        let i = 0;
        do {
          const a = this.build[i];
          const b = other.build[i];
          debug("build compare", i, a, b);
          if (a === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a === void 0) {
            return -1;
          } else if (a === b) {
            continue;
          } else {
            return compareIdentifiers(a, b);
          }
        } while (++i);
      }
      // preminor will bump the version up to the next minor release, and immediately
      // down to pre-release. premajor and prepatch work the same way.
      inc(release, identifier, identifierBase) {
        if (release.startsWith("pre")) {
          if (!identifier && identifierBase === false) {
            throw new Error("invalid increment argument: identifier is empty");
          }
          if (identifier) {
            const match = `-${identifier}`.match(this.options.loose ? re[t.PRERELEASELOOSE] : re[t.PRERELEASE]);
            if (!match || match[1] !== identifier) {
              throw new Error(`invalid identifier: ${identifier}`);
            }
          }
        }
        switch (release) {
          case "premajor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor = 0;
            this.major++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "preminor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "prepatch":
            this.prerelease.length = 0;
            this.inc("patch", identifier, identifierBase);
            this.inc("pre", identifier, identifierBase);
            break;
          // If the input is a non-prerelease version, this acts the same as
          // prepatch.
          case "prerelease":
            if (this.prerelease.length === 0) {
              this.inc("patch", identifier, identifierBase);
            }
            this.inc("pre", identifier, identifierBase);
            break;
          case "release":
            if (this.prerelease.length === 0) {
              throw new Error(`version ${this.raw} is not a prerelease`);
            }
            this.prerelease.length = 0;
            break;
          case "major":
            if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0) {
              this.major++;
            }
            this.minor = 0;
            this.patch = 0;
            this.prerelease = [];
            break;
          case "minor":
            if (this.patch !== 0 || this.prerelease.length === 0) {
              this.minor++;
            }
            this.patch = 0;
            this.prerelease = [];
            break;
          case "patch":
            if (this.prerelease.length === 0) {
              this.patch++;
            }
            this.prerelease = [];
            break;
          // This probably shouldn't be used publicly.
          // 1.0.0 'pre' would become 1.0.0-0 which is the wrong direction.
          case "pre": {
            const base = Number(identifierBase) ? 1 : 0;
            if (this.prerelease.length === 0) {
              this.prerelease = [base];
            } else {
              let i = this.prerelease.length;
              while (--i >= 0) {
                if (typeof this.prerelease[i] === "number") {
                  this.prerelease[i]++;
                  i = -2;
                }
              }
              if (i === -1) {
                if (identifier === this.prerelease.join(".") && identifierBase === false) {
                  throw new Error("invalid increment argument: identifier already exists");
                }
                this.prerelease.push(base);
              }
            }
            if (identifier) {
              let prerelease = [identifier, base];
              if (identifierBase === false) {
                prerelease = [identifier];
              }
              if (isPrereleaseIdentifier(this.prerelease, identifier)) {
                const prereleaseBase = this.prerelease[identifier.split(".").length];
                if (isNaN(prereleaseBase)) {
                  this.prerelease = prerelease;
                }
              } else {
                this.prerelease = prerelease;
              }
            }
            break;
          }
          default:
            throw new Error(`invalid increment argument: ${release}`);
        }
        this.raw = this.format();
        if (this.build.length) {
          this.raw += `+${this.build.join(".")}`;
        }
        return this;
      }
    };
    module.exports = SemVer;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/parse.js
var require_parse = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/parse.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var parse = (version, options, throwErrors = false) => {
      if (version instanceof SemVer) {
        return version;
      }
      try {
        return new SemVer(version, options);
      } catch (er) {
        if (!throwErrors) {
          return null;
        }
        throw er;
      }
    };
    module.exports = parse;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/valid.js
var require_valid = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/valid.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var valid2 = (version, options) => {
      const v2 = parse(version, options);
      return v2 ? v2.version : null;
    };
    module.exports = valid2;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/clean.js
var require_clean = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/clean.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var clean = (version, options) => {
      const s = parse(version.trim().replace(/^[=v]+/, ""), options);
      return s ? s.version : null;
    };
    module.exports = clean;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/inc.js
var require_inc = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/inc.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var inc = (version, release, options, identifier, identifierBase) => {
      if (typeof options === "string") {
        identifierBase = identifier;
        identifier = options;
        options = void 0;
      }
      try {
        return new SemVer(
          version instanceof SemVer ? version.version : version,
          options
        ).inc(release, identifier, identifierBase).version;
      } catch (er) {
        return null;
      }
    };
    module.exports = inc;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/diff.js
var require_diff = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/diff.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var diff = (version1, version2) => {
      const v1 = parse(version1, null, true);
      const v2 = parse(version2, null, true);
      const comparison = v1.compare(v2);
      if (comparison === 0) {
        return null;
      }
      const v1Higher = comparison > 0;
      const highVersion = v1Higher ? v1 : v2;
      const lowVersion = v1Higher ? v2 : v1;
      const highHasPre = !!highVersion.prerelease.length;
      const lowHasPre = !!lowVersion.prerelease.length;
      if (lowHasPre && !highHasPre) {
        if (!lowVersion.patch && !lowVersion.minor) {
          return "major";
        }
        if (lowVersion.compareMain(highVersion) === 0) {
          if (lowVersion.minor && !lowVersion.patch) {
            return "minor";
          }
          return "patch";
        }
      }
      const prefix = highHasPre ? "pre" : "";
      if (v1.major !== v2.major) {
        return prefix + "major";
      }
      if (v1.minor !== v2.minor) {
        return prefix + "minor";
      }
      if (v1.patch !== v2.patch) {
        return prefix + "patch";
      }
      return "prerelease";
    };
    module.exports = diff;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/major.js
var require_major = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/major.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var major = (a, loose) => new SemVer(a, loose).major;
    module.exports = major;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/minor.js
var require_minor = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/minor.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var minor = (a, loose) => new SemVer(a, loose).minor;
    module.exports = minor;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/patch.js
var require_patch = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/patch.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var patch = (a, loose) => new SemVer(a, loose).patch;
    module.exports = patch;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/prerelease.js
var require_prerelease = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/prerelease.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var prerelease = (version, options) => {
      const parsed = parse(version, options);
      return parsed && parsed.prerelease.length ? parsed.prerelease : null;
    };
    module.exports = prerelease;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare.js
var require_compare = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var compare = (a, b, loose) => new SemVer(a, loose).compare(new SemVer(b, loose));
    module.exports = compare;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/rcompare.js
var require_rcompare = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/rcompare.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var rcompare = (a, b, loose) => compare(b, a, loose);
    module.exports = rcompare;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare-loose.js
var require_compare_loose = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare-loose.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var compareLoose = (a, b) => compare(a, b, true);
    module.exports = compareLoose;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare-build.js
var require_compare_build = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare-build.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var compareBuild = (a, b, loose) => {
      const versionA = new SemVer(a, loose);
      const versionB = new SemVer(b, loose);
      return versionA.compare(versionB) || versionA.compareBuild(versionB);
    };
    module.exports = compareBuild;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/sort.js
var require_sort = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/sort.js"(exports, module) {
    "use strict";
    var compareBuild = require_compare_build();
    var sort = (list, loose) => list.sort((a, b) => compareBuild(a, b, loose));
    module.exports = sort;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/rsort.js
var require_rsort = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/rsort.js"(exports, module) {
    "use strict";
    var compareBuild = require_compare_build();
    var rsort = (list, loose) => list.sort((a, b) => compareBuild(b, a, loose));
    module.exports = rsort;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/gt.js
var require_gt = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/gt.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var gt = (a, b, loose) => compare(a, b, loose) > 0;
    module.exports = gt;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/lt.js
var require_lt = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/lt.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var lt = (a, b, loose) => compare(a, b, loose) < 0;
    module.exports = lt;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/eq.js
var require_eq = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/eq.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var eq = (a, b, loose) => compare(a, b, loose) === 0;
    module.exports = eq;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/neq.js
var require_neq = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/neq.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var neq = (a, b, loose) => compare(a, b, loose) !== 0;
    module.exports = neq;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/gte.js
var require_gte = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/gte.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var gte2 = (a, b, loose) => compare(a, b, loose) >= 0;
    module.exports = gte2;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/lte.js
var require_lte = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/lte.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var lte = (a, b, loose) => compare(a, b, loose) <= 0;
    module.exports = lte;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/cmp.js
var require_cmp = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/cmp.js"(exports, module) {
    "use strict";
    var eq = require_eq();
    var neq = require_neq();
    var gt = require_gt();
    var gte2 = require_gte();
    var lt = require_lt();
    var lte = require_lte();
    var cmp = (a, op, b, loose) => {
      switch (op) {
        case "===":
          if (typeof a === "object") {
            a = a.version;
          }
          if (typeof b === "object") {
            b = b.version;
          }
          return a === b;
        case "!==":
          if (typeof a === "object") {
            a = a.version;
          }
          if (typeof b === "object") {
            b = b.version;
          }
          return a !== b;
        case "":
        case "=":
        case "==":
          return eq(a, b, loose);
        case "!=":
          return neq(a, b, loose);
        case ">":
          return gt(a, b, loose);
        case ">=":
          return gte2(a, b, loose);
        case "<":
          return lt(a, b, loose);
        case "<=":
          return lte(a, b, loose);
        default:
          throw new TypeError(`Invalid operator: ${op}`);
      }
    };
    module.exports = cmp;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/coerce.js
var require_coerce = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/coerce.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var parse = require_parse();
    var { safeRe: re, t } = require_re();
    var coerce2 = (version, options) => {
      if (version instanceof SemVer) {
        return version;
      }
      if (typeof version === "number") {
        version = String(version);
      }
      if (typeof version !== "string") {
        return null;
      }
      options = options || {};
      let match = null;
      if (!options.rtl) {
        match = version.match(options.includePrerelease ? re[t.COERCEFULL] : re[t.COERCE]);
      } else {
        const coerceRtlRegex = options.includePrerelease ? re[t.COERCERTLFULL] : re[t.COERCERTL];
        let next;
        while ((next = coerceRtlRegex.exec(version)) && (!match || match.index + match[0].length !== version.length)) {
          if (!match || next.index + next[0].length !== match.index + match[0].length) {
            match = next;
          }
          coerceRtlRegex.lastIndex = next.index + next[1].length + next[2].length;
        }
        coerceRtlRegex.lastIndex = -1;
      }
      if (match === null) {
        return null;
      }
      const major = match[2];
      const minor = match[3] || "0";
      const patch = match[4] || "0";
      const prerelease = options.includePrerelease && match[5] ? `-${match[5]}` : "";
      const build = options.includePrerelease && match[6] ? `+${match[6]}` : "";
      return parse(`${major}.${minor}.${patch}${prerelease}${build}`, options);
    };
    module.exports = coerce2;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/truncate.js
var require_truncate = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/truncate.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var constants = require_constants();
    var SemVer = require_semver();
    var truncate = (version, truncation, options) => {
      if (!constants.RELEASE_TYPES.includes(truncation)) {
        return null;
      }
      const clonedVersion = cloneInputVersion(version, options);
      return clonedVersion && doTruncation(clonedVersion, truncation);
    };
    var cloneInputVersion = (version, options) => {
      const versionStringToParse = version instanceof SemVer ? version.version : version;
      return parse(versionStringToParse, options);
    };
    var doTruncation = (version, truncation) => {
      if (isPrerelease(truncation)) {
        return version.version;
      }
      version.prerelease = [];
      switch (truncation) {
        case "major":
          version.minor = 0;
          version.patch = 0;
          break;
        case "minor":
          version.patch = 0;
          break;
      }
      return version.format();
    };
    var isPrerelease = (type) => {
      return type.startsWith("pre");
    };
    module.exports = truncate;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/lrucache.js
var require_lrucache = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/lrucache.js"(exports, module) {
    "use strict";
    var LRUCache = class {
      constructor() {
        this.max = 1e3;
        this.map = /* @__PURE__ */ new Map();
      }
      get(key2) {
        const value = this.map.get(key2);
        if (value === void 0) {
          return void 0;
        } else {
          this.map.delete(key2);
          this.map.set(key2, value);
          return value;
        }
      }
      delete(key2) {
        return this.map.delete(key2);
      }
      set(key2, value) {
        const deleted = this.delete(key2);
        if (!deleted && value !== void 0) {
          if (this.map.size >= this.max) {
            const firstKey = this.map.keys().next().value;
            this.delete(firstKey);
          }
          this.map.set(key2, value);
        }
        return this;
      }
    };
    module.exports = LRUCache;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/range.js
var require_range = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/range.js"(exports, module) {
    "use strict";
    var SPACE_CHARACTERS = /\s+/g;
    var Range = class _Range {
      constructor(range, options) {
        options = parseOptions(options);
        if (range instanceof _Range) {
          if (range.loose === !!options.loose && range.includePrerelease === !!options.includePrerelease) {
            return range;
          } else {
            return new _Range(range.raw, options);
          }
        }
        if (range instanceof Comparator) {
          this.raw = range.value;
          this.set = [[range]];
          this.formatted = void 0;
          return this;
        }
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        this.raw = range.trim().replace(SPACE_CHARACTERS, " ");
        this.set = this.raw.split("||").map((r) => this.parseRange(r.trim())).filter((c) => c.length);
        if (!this.set.length) {
          throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
        }
        if (this.set.length > 1) {
          const first = this.set[0];
          this.set = this.set.filter((c) => !isNullSet(c[0]));
          if (this.set.length === 0) {
            this.set = [first];
          } else if (this.set.length > 1) {
            for (const c of this.set) {
              if (c.length === 1 && isAny(c[0])) {
                this.set = [c];
                break;
              }
            }
          }
        }
        this.formatted = void 0;
      }
      get range() {
        if (this.formatted === void 0) {
          this.formatted = "";
          for (let i = 0; i < this.set.length; i++) {
            if (i > 0) {
              this.formatted += "||";
            }
            const comps = this.set[i];
            for (let k = 0; k < comps.length; k++) {
              if (k > 0) {
                this.formatted += " ";
              }
              this.formatted += comps[k].toString().trim();
            }
          }
        }
        return this.formatted;
      }
      format() {
        return this.range;
      }
      toString() {
        return this.range;
      }
      parseRange(range) {
        range = range.replace(BUILDSTRIPRE, "");
        const memoOpts = (this.options.includePrerelease && FLAG_INCLUDE_PRERELEASE) | (this.options.loose && FLAG_LOOSE);
        const memoKey = memoOpts + ":" + range;
        const cached = cache.get(memoKey);
        if (cached) {
          return cached;
        }
        const loose = this.options.loose;
        const hr = loose ? re[t.HYPHENRANGELOOSE] : re[t.HYPHENRANGE];
        range = range.replace(hr, hyphenReplace(this.options.includePrerelease));
        debug("hyphen replace", range);
        range = range.replace(re[t.COMPARATORTRIM], comparatorTrimReplace);
        debug("comparator trim", range);
        range = range.replace(re[t.TILDETRIM], tildeTrimReplace);
        debug("tilde trim", range);
        range = range.replace(re[t.CARETTRIM], caretTrimReplace);
        debug("caret trim", range);
        let rangeList = range.split(" ").map((comp) => parseComparator(comp, this.options)).join(" ").split(/\s+/).map((comp) => replaceGTE0(comp, this.options));
        if (loose) {
          rangeList = rangeList.filter((comp) => {
            debug("loose invalid filter", comp, this.options);
            return !!comp.match(re[t.COMPARATORLOOSE]);
          });
        }
        debug("range list", rangeList);
        const rangeMap = /* @__PURE__ */ new Map();
        const comparators = rangeList.map((comp) => new Comparator(comp, this.options));
        for (const comp of comparators) {
          if (isNullSet(comp)) {
            return [comp];
          }
          rangeMap.set(comp.value, comp);
        }
        if (rangeMap.size > 1 && rangeMap.has("")) {
          rangeMap.delete("");
        }
        const result = [...rangeMap.values()];
        cache.set(memoKey, result);
        return result;
      }
      intersects(range, options) {
        if (!(range instanceof _Range)) {
          throw new TypeError("a Range is required");
        }
        return this.set.some((thisComparators) => {
          return isSatisfiable(thisComparators, options) && range.set.some((rangeComparators) => {
            return isSatisfiable(rangeComparators, options) && thisComparators.every((thisComparator) => {
              return rangeComparators.every((rangeComparator) => {
                return thisComparator.intersects(rangeComparator, options);
              });
            });
          });
        });
      }
      // if ANY of the sets match ALL of its comparators, then pass
      test(version) {
        if (!version) {
          return false;
        }
        if (typeof version === "string") {
          try {
            version = new SemVer(version, this.options);
          } catch (er) {
            return false;
          }
        }
        for (let i = 0; i < this.set.length; i++) {
          if (testSet(this.set[i], version, this.options)) {
            return true;
          }
        }
        return false;
      }
    };
    module.exports = Range;
    var LRU = require_lrucache();
    var cache = new LRU();
    var parseOptions = require_parse_options();
    var Comparator = require_comparator();
    var debug = require_debug();
    var SemVer = require_semver();
    var {
      safeRe: re,
      src,
      t,
      comparatorTrimReplace,
      tildeTrimReplace,
      caretTrimReplace
    } = require_re();
    var { FLAG_INCLUDE_PRERELEASE, FLAG_LOOSE } = require_constants();
    var BUILDSTRIPRE = new RegExp(src[t.BUILD], "g");
    var isNullSet = (c) => c.value === "<0.0.0-0";
    var isAny = (c) => c.value === "";
    var isSatisfiable = (comparators, options) => {
      let result = true;
      const remainingComparators = comparators.slice();
      let testComparator = remainingComparators.pop();
      while (result && remainingComparators.length) {
        result = remainingComparators.every((otherComparator) => {
          return testComparator.intersects(otherComparator, options);
        });
        testComparator = remainingComparators.pop();
      }
      return result;
    };
    var parseComparator = (comp, options) => {
      comp = comp.replace(re[t.BUILD], "");
      debug("comp", comp, options);
      comp = replaceCarets(comp, options);
      debug("caret", comp);
      comp = replaceTildes(comp, options);
      debug("tildes", comp);
      comp = replaceXRanges(comp, options);
      debug("xrange", comp);
      comp = replaceStars(comp, options);
      debug("stars", comp);
      return comp;
    };
    var isX = (id4) => !id4 || id4.toLowerCase() === "x" || id4 === "*";
    var invalidXRangeOrder = (M, m, p) => isX(M) && !isX(m) || isX(m) && p && !isX(p);
    var replaceTildes = (comp, options) => {
      return comp.trim().split(/\s+/).map((c) => replaceTilde(c, options)).join(" ");
    };
    var replaceTilde = (comp, options) => {
      const r = options.loose ? re[t.TILDELOOSE] : re[t.TILDE];
      const z27 = options.includePrerelease ? "-0" : "";
      return comp.replace(r, (_, M, m, p, pr) => {
        debug("tilde", comp, _, M, m, p, pr);
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0${z27} <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          ret = `>=${M}.${m}.0${z27} <${M}.${+m + 1}.0-0`;
        } else if (pr) {
          debug("replaceTilde pr", pr);
          ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
        } else {
          ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
        }
        debug("tilde return", ret);
        return ret;
      });
    };
    var replaceCarets = (comp, options) => {
      return comp.trim().split(/\s+/).map((c) => replaceCaret(c, options)).join(" ");
    };
    var replaceCaret = (comp, options) => {
      debug("caret", comp, options);
      const r = options.loose ? re[t.CARETLOOSE] : re[t.CARET];
      const z27 = options.includePrerelease ? "-0" : "";
      return comp.replace(r, (_, M, m, p, pr) => {
        debug("caret", comp, _, M, m, p, pr);
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0${z27} <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          if (M === "0") {
            ret = `>=${M}.${m}.0${z27} <${M}.${+m + 1}.0-0`;
          } else {
            ret = `>=${M}.${m}.0${z27} <${+M + 1}.0.0-0`;
          }
        } else if (pr) {
          debug("replaceCaret pr", pr);
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
          }
        } else {
          debug("no pr");
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
          }
        }
        debug("caret return", ret);
        return ret;
      });
    };
    var replaceXRanges = (comp, options) => {
      debug("replaceXRanges", comp, options);
      return comp.split(/\s+/).map((c) => replaceXRange(c, options)).join(" ");
    };
    var replaceXRange = (comp, options) => {
      comp = comp.trim();
      const r = options.loose ? re[t.XRANGELOOSE] : re[t.XRANGE];
      return comp.replace(r, (ret, gtlt, M, m, p, pr) => {
        debug("xRange", comp, ret, gtlt, M, m, p, pr);
        if (invalidXRangeOrder(M, m, p)) {
          return comp;
        }
        const xM = isX(M);
        const xm = xM || isX(m);
        const xp = xm || isX(p);
        const anyX = xp;
        if (gtlt === "=" && anyX) {
          gtlt = "";
        }
        pr = options.includePrerelease ? "-0" : "";
        if (xM) {
          if (gtlt === ">" || gtlt === "<") {
            ret = "<0.0.0-0";
          } else {
            ret = "*";
          }
        } else if (gtlt && anyX) {
          if (xm) {
            m = 0;
          }
          p = 0;
          if (gtlt === ">") {
            gtlt = ">=";
            if (xm) {
              M = +M + 1;
              m = 0;
              p = 0;
            } else {
              m = +m + 1;
              p = 0;
            }
          } else if (gtlt === "<=") {
            gtlt = "<";
            if (xm) {
              M = +M + 1;
            } else {
              m = +m + 1;
            }
          }
          if (gtlt === "<") {
            pr = "-0";
          }
          ret = `${gtlt + M}.${m}.${p}${pr}`;
        } else if (xm) {
          ret = `>=${M}.0.0${pr} <${+M + 1}.0.0-0`;
        } else if (xp) {
          ret = `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`;
        }
        debug("xRange return", ret);
        return ret;
      });
    };
    var replaceStars = (comp, options) => {
      debug("replaceStars", comp, options);
      return comp.trim().replace(re[t.STAR], "");
    };
    var replaceGTE0 = (comp, options) => {
      debug("replaceGTE0", comp, options);
      return comp.trim().replace(re[options.includePrerelease ? t.GTE0PRE : t.GTE0], "");
    };
    var hyphenReplace = (incPr) => ($0, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
      if (isX(fM)) {
        from = "";
      } else if (isX(fm)) {
        from = `>=${fM}.0.0${incPr ? "-0" : ""}`;
      } else if (isX(fp)) {
        from = `>=${fM}.${fm}.0${incPr ? "-0" : ""}`;
      } else if (fpr) {
        from = `>=${from}`;
      } else {
        from = `>=${from}${incPr ? "-0" : ""}`;
      }
      if (isX(tM)) {
        to = "";
      } else if (isX(tm)) {
        to = `<${+tM + 1}.0.0-0`;
      } else if (isX(tp)) {
        to = `<${tM}.${+tm + 1}.0-0`;
      } else if (tpr) {
        to = `<=${tM}.${tm}.${tp}-${tpr}`;
      } else if (incPr) {
        to = `<${tM}.${tm}.${+tp + 1}-0`;
      } else {
        to = `<=${to}`;
      }
      return `${from} ${to}`.trim();
    };
    var testSet = (set, version, options) => {
      for (let i = 0; i < set.length; i++) {
        if (!set[i].test(version)) {
          return false;
        }
      }
      if (version.prerelease.length && !options.includePrerelease) {
        for (let i = 0; i < set.length; i++) {
          debug(set[i].semver);
          if (set[i].semver === Comparator.ANY) {
            continue;
          }
          if (set[i].semver.prerelease.length > 0) {
            const allowed = set[i].semver;
            if (allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch) {
              return true;
            }
          }
        }
        return false;
      }
      return true;
    };
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/comparator.js
var require_comparator = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/comparator.js"(exports, module) {
    "use strict";
    var ANY = /* @__PURE__ */ Symbol("SemVer ANY");
    var Comparator = class _Comparator {
      static get ANY() {
        return ANY;
      }
      constructor(comp, options) {
        options = parseOptions(options);
        if (comp instanceof _Comparator) {
          if (comp.loose === !!options.loose) {
            return comp;
          } else {
            comp = comp.value;
          }
        }
        comp = comp.trim().split(/\s+/).join(" ");
        debug("comparator", comp, options);
        this.options = options;
        this.loose = !!options.loose;
        this.parse(comp);
        if (this.semver === ANY) {
          this.value = "";
        } else {
          this.value = this.operator + this.semver.version;
        }
        debug("comp", this);
      }
      parse(comp) {
        const r = this.options.loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR];
        const m = comp.match(r);
        if (!m) {
          throw new TypeError(`Invalid comparator: ${comp}`);
        }
        this.operator = m[1] !== void 0 ? m[1] : "";
        if (this.operator === "=") {
          this.operator = "";
        }
        if (!m[2]) {
          this.semver = ANY;
        } else {
          this.semver = new SemVer(m[2], this.options.loose);
        }
      }
      toString() {
        return this.value;
      }
      test(version) {
        debug("Comparator.test", version, this.options.loose);
        if (this.semver === ANY || version === ANY) {
          return true;
        }
        if (typeof version === "string") {
          try {
            version = new SemVer(version, this.options);
          } catch (er) {
            return false;
          }
        }
        return cmp(version, this.operator, this.semver, this.options);
      }
      intersects(comp, options) {
        if (!(comp instanceof _Comparator)) {
          throw new TypeError("a Comparator is required");
        }
        if (this.operator === "") {
          if (this.value === "") {
            return true;
          }
          return new Range(comp.value, options).test(this.value);
        } else if (comp.operator === "") {
          if (comp.value === "") {
            return true;
          }
          return new Range(this.value, options).test(comp.semver);
        }
        options = parseOptions(options);
        if (options.includePrerelease && (this.value === "<0.0.0-0" || comp.value === "<0.0.0-0")) {
          return false;
        }
        if (!options.includePrerelease && (this.value.startsWith("<0.0.0") || comp.value.startsWith("<0.0.0"))) {
          return false;
        }
        if (this.operator.startsWith(">") && comp.operator.startsWith(">")) {
          return true;
        }
        if (this.operator.startsWith("<") && comp.operator.startsWith("<")) {
          return true;
        }
        if (this.semver.version === comp.semver.version && this.operator.includes("=") && comp.operator.includes("=")) {
          return true;
        }
        if (cmp(this.semver, "<", comp.semver, options) && this.operator.startsWith(">") && comp.operator.startsWith("<")) {
          return true;
        }
        if (cmp(this.semver, ">", comp.semver, options) && this.operator.startsWith("<") && comp.operator.startsWith(">")) {
          return true;
        }
        return false;
      }
    };
    module.exports = Comparator;
    var parseOptions = require_parse_options();
    var { safeRe: re, t } = require_re();
    var cmp = require_cmp();
    var debug = require_debug();
    var SemVer = require_semver();
    var Range = require_range();
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/satisfies.js
var require_satisfies = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/satisfies.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var satisfies = (version, range, options) => {
      try {
        range = new Range(range, options);
      } catch (er) {
        return false;
      }
      return range.test(version);
    };
    module.exports = satisfies;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/to-comparators.js
var require_to_comparators = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/to-comparators.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var toComparators = (range, options) => new Range(range, options).set.map((comp) => comp.map((c) => c.value).join(" ").trim().split(" "));
    module.exports = toComparators;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/max-satisfying.js
var require_max_satisfying = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/max-satisfying.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var maxSatisfying = (versions, range, options) => {
      let max = null;
      let maxSV = null;
      let rangeObj = null;
      try {
        rangeObj = new Range(range, options);
      } catch (er) {
        return null;
      }
      versions.forEach((v2) => {
        if (rangeObj.test(v2)) {
          if (!max || maxSV.compare(v2) === -1) {
            max = v2;
            maxSV = new SemVer(max, options);
          }
        }
      });
      return max;
    };
    module.exports = maxSatisfying;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/min-satisfying.js
var require_min_satisfying = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/min-satisfying.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var minSatisfying = (versions, range, options) => {
      let min = null;
      let minSV = null;
      let rangeObj = null;
      try {
        rangeObj = new Range(range, options);
      } catch (er) {
        return null;
      }
      versions.forEach((v2) => {
        if (rangeObj.test(v2)) {
          if (!min || minSV.compare(v2) === 1) {
            min = v2;
            minSV = new SemVer(min, options);
          }
        }
      });
      return min;
    };
    module.exports = minSatisfying;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/min-version.js
var require_min_version = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/min-version.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var gt = require_gt();
    var minVersion = (range, loose) => {
      range = new Range(range, loose);
      let minver = new SemVer("0.0.0");
      if (range.test(minver)) {
        return minver;
      }
      minver = new SemVer("0.0.0-0");
      if (range.test(minver)) {
        return minver;
      }
      minver = null;
      for (let i = 0; i < range.set.length; ++i) {
        const comparators = range.set[i];
        let setMin = null;
        comparators.forEach((comparator) => {
          const compver = new SemVer(comparator.semver.version);
          switch (comparator.operator) {
            case ">":
              if (compver.prerelease.length === 0) {
                compver.patch++;
              } else {
                compver.prerelease.push(0);
              }
              compver.raw = compver.format();
            /* fallthrough */
            case "":
            case ">=":
              if (!setMin || gt(compver, setMin)) {
                setMin = compver;
              }
              break;
            case "<":
            case "<=":
              break;
            /* istanbul ignore next */
            default:
              throw new Error(`Unexpected operation: ${comparator.operator}`);
          }
        });
        if (setMin && (!minver || gt(minver, setMin))) {
          minver = setMin;
        }
      }
      if (minver && range.test(minver)) {
        return minver;
      }
      return null;
    };
    module.exports = minVersion;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/valid.js
var require_valid2 = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/valid.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var validRange = (range, options) => {
      try {
        return new Range(range, options).range || "*";
      } catch (er) {
        return null;
      }
    };
    module.exports = validRange;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/outside.js
var require_outside = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/outside.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Comparator = require_comparator();
    var { ANY } = Comparator;
    var Range = require_range();
    var satisfies = require_satisfies();
    var gt = require_gt();
    var lt = require_lt();
    var lte = require_lte();
    var gte2 = require_gte();
    var outside = (version, range, hilo, options) => {
      version = new SemVer(version, options);
      range = new Range(range, options);
      let gtfn, ltefn, ltfn, comp, ecomp;
      switch (hilo) {
        case ">":
          gtfn = gt;
          ltefn = lte;
          ltfn = lt;
          comp = ">";
          ecomp = ">=";
          break;
        case "<":
          gtfn = lt;
          ltefn = gte2;
          ltfn = gt;
          comp = "<";
          ecomp = "<=";
          break;
        default:
          throw new TypeError('Must provide a hilo val of "<" or ">"');
      }
      if (satisfies(version, range, options)) {
        return false;
      }
      for (let i = 0; i < range.set.length; ++i) {
        const comparators = range.set[i];
        let high = null;
        let low = null;
        comparators.forEach((comparator) => {
          if (comparator.semver === ANY) {
            comparator = new Comparator(">=0.0.0");
          }
          high = high || comparator;
          low = low || comparator;
          if (gtfn(comparator.semver, high.semver, options)) {
            high = comparator;
          } else if (ltfn(comparator.semver, low.semver, options)) {
            low = comparator;
          }
        });
        if (high.operator === comp || high.operator === ecomp) {
          return false;
        }
        if ((!low.operator || low.operator === comp) && ltefn(version, low.semver)) {
          return false;
        } else if (low.operator === ecomp && ltfn(version, low.semver)) {
          return false;
        }
      }
      return true;
    };
    module.exports = outside;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/gtr.js
var require_gtr = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/gtr.js"(exports, module) {
    "use strict";
    var outside = require_outside();
    var gtr = (version, range, options) => outside(version, range, ">", options);
    module.exports = gtr;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/ltr.js
var require_ltr = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/ltr.js"(exports, module) {
    "use strict";
    var outside = require_outside();
    var ltr = (version, range, options) => outside(version, range, "<", options);
    module.exports = ltr;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/intersects.js
var require_intersects = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/intersects.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var intersects = (r1, r2, options) => {
      r1 = new Range(r1, options);
      r2 = new Range(r2, options);
      return r1.intersects(r2, options);
    };
    module.exports = intersects;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/simplify.js
var require_simplify = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/simplify.js"(exports, module) {
    "use strict";
    var satisfies = require_satisfies();
    var compare = require_compare();
    module.exports = (versions, range, options) => {
      const set = [];
      let first = null;
      let prev = null;
      const v2 = versions.sort((a, b) => compare(a, b, options));
      for (const version of v2) {
        const included = satisfies(version, range, options);
        if (included) {
          prev = version;
          if (!first) {
            first = version;
          }
        } else {
          if (prev) {
            set.push([first, prev]);
          }
          prev = null;
          first = null;
        }
      }
      if (first) {
        set.push([first, null]);
      }
      const ranges = [];
      for (const [min, max] of set) {
        if (min === max) {
          ranges.push(min);
        } else if (!max && min === v2[0]) {
          ranges.push("*");
        } else if (!max) {
          ranges.push(`>=${min}`);
        } else if (min === v2[0]) {
          ranges.push(`<=${max}`);
        } else {
          ranges.push(`${min} - ${max}`);
        }
      }
      const simplified = ranges.join(" || ");
      const original = typeof range.raw === "string" ? range.raw : String(range);
      return simplified.length < original.length ? simplified : range;
    };
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/subset.js
var require_subset = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/ranges/subset.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var Comparator = require_comparator();
    var { ANY } = Comparator;
    var satisfies = require_satisfies();
    var compare = require_compare();
    var subset = (sub, dom, options = {}) => {
      if (sub === dom) {
        return true;
      }
      sub = new Range(sub, options);
      dom = new Range(dom, options);
      let sawNonNull = false;
      OUTER: for (const simpleSub of sub.set) {
        for (const simpleDom of dom.set) {
          const isSub = simpleSubset(simpleSub, simpleDom, options);
          sawNonNull = sawNonNull || isSub !== null;
          if (isSub) {
            continue OUTER;
          }
        }
        if (sawNonNull) {
          return false;
        }
      }
      return true;
    };
    var minimumVersionWithPreRelease = [new Comparator(">=0.0.0-0")];
    var minimumVersion = [new Comparator(">=0.0.0")];
    var simpleSubset = (sub, dom, options) => {
      if (sub === dom) {
        return true;
      }
      if (sub.length === 1 && sub[0].semver === ANY) {
        if (dom.length === 1 && dom[0].semver === ANY) {
          return true;
        } else if (options.includePrerelease) {
          sub = minimumVersionWithPreRelease;
        } else {
          sub = minimumVersion;
        }
      }
      if (dom.length === 1 && dom[0].semver === ANY) {
        if (options.includePrerelease) {
          return true;
        } else {
          dom = minimumVersion;
        }
      }
      const eqSet = /* @__PURE__ */ new Set();
      let gt, lt;
      for (const c of sub) {
        if (c.operator === ">" || c.operator === ">=") {
          gt = higherGT(gt, c, options);
        } else if (c.operator === "<" || c.operator === "<=") {
          lt = lowerLT(lt, c, options);
        } else {
          eqSet.add(c.semver);
        }
      }
      if (eqSet.size > 1) {
        return null;
      }
      let gtltComp;
      if (gt && lt) {
        gtltComp = compare(gt.semver, lt.semver, options);
        if (gtltComp > 0) {
          return null;
        } else if (gtltComp === 0 && (gt.operator !== ">=" || lt.operator !== "<=")) {
          return null;
        }
      }
      for (const eq of eqSet) {
        if (gt && !satisfies(eq, String(gt), options)) {
          return null;
        }
        if (lt && !satisfies(eq, String(lt), options)) {
          return null;
        }
        for (const c of dom) {
          if (!satisfies(eq, String(c), options)) {
            return false;
          }
        }
        return true;
      }
      let higher, lower;
      let hasDomLT, hasDomGT;
      let needDomLTPre = lt && !options.includePrerelease && lt.semver.prerelease.length ? lt.semver : false;
      let needDomGTPre = gt && !options.includePrerelease && gt.semver.prerelease.length ? gt.semver : false;
      if (needDomLTPre && needDomLTPre.prerelease.length === 1 && lt.operator === "<" && needDomLTPre.prerelease[0] === 0) {
        needDomLTPre = false;
      }
      for (const c of dom) {
        hasDomGT = hasDomGT || c.operator === ">" || c.operator === ">=";
        hasDomLT = hasDomLT || c.operator === "<" || c.operator === "<=";
        if (gt) {
          if (needDomGTPre) {
            if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomGTPre.major && c.semver.minor === needDomGTPre.minor && c.semver.patch === needDomGTPre.patch) {
              needDomGTPre = false;
            }
          }
          if (c.operator === ">" || c.operator === ">=") {
            higher = higherGT(gt, c, options);
            if (higher === c && higher !== gt) {
              return false;
            }
          } else if (gt.operator === ">=" && !c.test(gt.semver)) {
            return false;
          }
        }
        if (lt) {
          if (needDomLTPre) {
            if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomLTPre.major && c.semver.minor === needDomLTPre.minor && c.semver.patch === needDomLTPre.patch) {
              needDomLTPre = false;
            }
          }
          if (c.operator === "<" || c.operator === "<=") {
            lower = lowerLT(lt, c, options);
            if (lower === c && lower !== lt) {
              return false;
            }
          } else if (lt.operator === "<=" && !c.test(lt.semver)) {
            return false;
          }
        }
        if (!c.operator && (lt || gt) && gtltComp !== 0) {
          return false;
        }
      }
      if (gt && hasDomLT && !lt && gtltComp !== 0) {
        return false;
      }
      if (lt && hasDomGT && !gt && gtltComp !== 0) {
        return false;
      }
      if (needDomGTPre || needDomLTPre) {
        return false;
      }
      return true;
    };
    var higherGT = (a, b, options) => {
      if (!a) {
        return b;
      }
      const comp = compare(a.semver, b.semver, options);
      return comp > 0 ? a : comp < 0 ? b : b.operator === ">" && a.operator === ">=" ? b : a;
    };
    var lowerLT = (a, b, options) => {
      if (!a) {
        return b;
      }
      const comp = compare(a.semver, b.semver, options);
      return comp < 0 ? a : comp > 0 ? b : b.operator === "<" && a.operator === "<=" ? b : a;
    };
    module.exports = subset;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/index.js
var require_semver2 = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/index.js"(exports, module) {
    "use strict";
    var internalRe = require_re();
    var constants = require_constants();
    var SemVer = require_semver();
    var identifiers = require_identifiers();
    var parse = require_parse();
    var valid2 = require_valid();
    var clean = require_clean();
    var inc = require_inc();
    var diff = require_diff();
    var major = require_major();
    var minor = require_minor();
    var patch = require_patch();
    var prerelease = require_prerelease();
    var compare = require_compare();
    var rcompare = require_rcompare();
    var compareLoose = require_compare_loose();
    var compareBuild = require_compare_build();
    var sort = require_sort();
    var rsort = require_rsort();
    var gt = require_gt();
    var lt = require_lt();
    var eq = require_eq();
    var neq = require_neq();
    var gte2 = require_gte();
    var lte = require_lte();
    var cmp = require_cmp();
    var coerce2 = require_coerce();
    var truncate = require_truncate();
    var Comparator = require_comparator();
    var Range = require_range();
    var satisfies = require_satisfies();
    var toComparators = require_to_comparators();
    var maxSatisfying = require_max_satisfying();
    var minSatisfying = require_min_satisfying();
    var minVersion = require_min_version();
    var validRange = require_valid2();
    var outside = require_outside();
    var gtr = require_gtr();
    var ltr = require_ltr();
    var intersects = require_intersects();
    var simplifyRange = require_simplify();
    var subset = require_subset();
    module.exports = {
      parse,
      valid: valid2,
      clean,
      inc,
      diff,
      major,
      minor,
      patch,
      prerelease,
      compare,
      rcompare,
      compareLoose,
      compareBuild,
      sort,
      rsort,
      gt,
      lt,
      eq,
      neq,
      gte: gte2,
      lte,
      cmp,
      coerce: coerce2,
      truncate,
      Comparator,
      Range,
      satisfies,
      toComparators,
      maxSatisfying,
      minSatisfying,
      minVersion,
      validRange,
      outside,
      gtr,
      ltr,
      intersects,
      simplifyRange,
      subset,
      SemVer,
      re: internalRe.re,
      src: internalRe.src,
      tokens: internalRe.t,
      SEMVER_SPEC_VERSION: constants.SEMVER_SPEC_VERSION,
      RELEASE_TYPES: constants.RELEASE_TYPES,
      compareIdentifiers: identifiers.compareIdentifiers,
      rcompareIdentifiers: identifiers.rcompareIdentifiers
    };
  }
});

// ../protocol/src/coordinator.ts
import { z } from "zod";
var coordinatorRuntimeSchema = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("ai_sdk") }).strict(),
  z.object({ harness: z.enum(["claude_code", "codex"]), deviceId: z.uuid(), model: z.string().trim().min(1).max(120).optional() }).strict()
]);
var coordinatorToolSpecSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  description: z.string().max(2e4),
  inputSchema: z.record(z.string(), z.unknown())
});
var nativeCoordinatorJobSchema = z.object({
  id: z.uuid(),
  harness: z.enum(["claude_code", "codex"]),
  model: z.string().optional(),
  instructions: z.string().min(1).max(2e5),
  context: z.string().min(1).max(5e5),
  tools: z.array(coordinatorToolSpecSchema).max(100),
  expiresAt: z.iso.datetime()
});
var nativeCoordinatorClaimSchema = z.object({ job: nativeCoordinatorJobSchema.nullable() });
var nativeCoordinatorCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), callId: z.string().min(1).max(200), name: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("complete"), text: z.string().min(1).max(2e5).refine((value) => value.trim().length > 0) }).strict(),
  z.object({ type: z.literal("failed") }).strict()
]);
var nativeCoordinatorToolResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("done"), output: z.unknown() })
]);

// src/server-link-http.ts
import { z as z26 } from "zod";

// src/agents/tool-approval.ts
async function abortable(work, signal) {
  if (signal.aborted) throw new Error("cancelled");
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
var ToolApprovalGate = class {
  constructor(runId, host) {
    this.runId = runId;
    this.host = host;
  }
  runId;
  host;
  stop = new AbortController();
  revoke() {
    this.stop.abort();
  }
  get revoked() {
    return this.stop.signal.aborted;
  }
  onRevoke(callback) {
    if (this.revoked) {
      callback();
      return () => {
      };
    }
    this.stop.signal.addEventListener("abort", callback, { once: true });
    return () => this.stop.signal.removeEventListener("abort", callback);
  }
  async checkLive() {
    if (this.revoked) return false;
    try {
      return await abortable(Promise.resolve(this.host.isLive(this.runId)), this.stop.signal) && !this.revoked;
    } catch {
      return false;
    }
  }
};

// ../protocol/src/policy-snapshot.ts
import { z as z3 } from "zod";

// ../protocol/src/agent-policy.ts
import { z as z2 } from "zod";
var PERMISSION_DECISIONS = ["allow", "ask", "deny"];
var CONFIGURABLE_PERMISSIONS = {
  install_dependency: ["allow", "ask", "deny"],
  // Everything outside the worktree is read-only in the sandbox (ADR 0009,
  // Stage 1 isolation), so writing there cannot be allowed wholesale.
  write_outside_repo: ["ask", "deny"],
  // Push is what the GitHub App grants (decision 2026-11-01-1215): never asked.
  git_push: ["allow", "deny"],
  network: ["allow", "ask", "deny"],
  computer_use: ["allow", "ask", "deny"]
};
var CONFIGURABLE_ACTIONS = Object.keys(
  CONFIGURABLE_PERMISSIONS
);
var FIXED_PERMISSIONS = {
  read_in_worktree: "allow",
  write_in_worktree: "allow",
  run_project_script: "allow",
  // Allowed once the user approved the repo's recipe; asked before that.
  run_setup_recipe: "allow"
};
var PERMISSION_DEFAULTS = {
  ...FIXED_PERMISSIONS,
  install_dependency: "allow",
  write_outside_repo: "ask",
  // A run pushes only when the server sends allow for an admitted GitHub App
  // grant (decision 2026-11-01-1215); a policy that does not say so never pushes.
  git_push: "deny",
  // Agents reach the open internet unless a person restricts it in settings
  // (decision 2026-11-01-1230-network-open-by-default).
  network: "allow",
  computer_use: "ask"
};
function permissionChoiceAllowed(action, decision) {
  return CONFIGURABLE_PERMISSIONS[action].includes(
    decision
  );
}
var NETWORK_DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;
var MAX_NETWORK_DOMAINS = 200;
var MAX_GUIDANCE_LENGTH = 1e4;
var MAX_MODEL_NAME_LENGTH = 120;
var networkDomainSchema = z2.string().trim().toLowerCase().min(1).max(253).regex(NETWORK_DOMAIN_RE);
function normalizeDomains(domains) {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(
    Boolean
  );
}
var networkAllowSchema = z2.array(networkDomainSchema).max(MAX_NETWORK_DOMAINS).transform(normalizeDomains);
var storedPermissionsSchema = z2.strictObject({
  install_dependency: z2.enum(CONFIGURABLE_PERMISSIONS.install_dependency),
  write_outside_repo: z2.enum(CONFIGURABLE_PERMISSIONS.write_outside_repo),
  // A stored ask predates decision 2026-11-01-1215 and reads as allow.
  git_push: z2.enum(PERMISSION_DECISIONS).transform((value) => value === "ask" ? "allow" : value),
  network: z2.enum(CONFIGURABLE_PERMISSIONS.network),
  computer_use: z2.enum(CONFIGURABLE_PERMISSIONS.computer_use)
}).partial();
var guidanceSchema = z2.string().max(MAX_GUIDANCE_LENGTH);
var DEFAULT_NETWORK_ALLOW = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com"
];
var runPolicySchema = z2.strictObject({
  permissions: z2.strictObject({
    install_dependency: z2.enum(PERMISSION_DECISIONS),
    write_outside_repo: z2.enum(PERMISSION_DECISIONS),
    // Push is allow (admitted) or deny; an older server's ask carries no push authority.
    git_push: z2.enum(PERMISSION_DECISIONS).transform((value) => value === "ask" ? "deny" : value),
    network: z2.enum(PERMISSION_DECISIONS),
    // Older servers omit this field; the daemon treats that as ask, never allow.
    computer_use: z2.enum(PERMISSION_DECISIONS).optional()
  }),
  /** The workspace layer of the domain allow-list (ADR 0009). */
  networkAllow: z2.array(z2.string().min(1).max(253)).max(MAX_NETWORK_DOMAINS),
  /** Host-derived worker/workspace ceiling; even network=allow cannot widen it. */
  networkCeiling: z2.array(networkDomainSchema).max(MAX_NETWORK_DOMAINS).optional(),
  /**
   * The run only reads: the worktree is not writable and nothing is pushed
   * (ADR 0046). Absent from an older server means a normal, writable run.
   */
  readOnly: z2.boolean().optional()
});
var MODEL_HARNESSES = ["claude_code", "codex", "cursor"];
var modelHarnessSchema = z2.enum(MODEL_HARNESSES);
var modelNameSchema = z2.string().trim().min(1).max(MAX_MODEL_NAME_LENGTH);
var modelByHarnessSchema = z2.strictObject({
  claude_code: modelNameSchema,
  codex: modelNameSchema,
  cursor: modelNameSchema
}).partial();
var APPROVAL_MODES = ["ask", "read_only"];
var approvalModeSchema = z2.enum(APPROVAL_MODES);
function resolvePermissions(stored, environment = "local") {
  const out = {};
  const record = stored && typeof stored === "object" ? stored : {};
  for (const action of CONFIGURABLE_ACTIONS) {
    const value = record[action];
    out[action] = typeof value === "string" && permissionChoiceAllowed(action, value) ? value : PERMISSION_DEFAULTS[action];
  }
  return out;
}
function resolveNetworkAllow(stored) {
  if (stored === null || stored === void 0) return [...DEFAULT_NETWORK_ALLOW];
  const parsed = networkAllowSchema.safeParse(stored);
  return parsed.success ? parsed.data : [...DEFAULT_NETWORK_ALLOW];
}
function resolveAgentSettings(workspace, team, environment = "local") {
  const permissions = resolvePermissions(workspace?.permissions, environment);
  const explicit = storedPermissionsSchema.safeParse(workspace?.permissions ?? {});
  if (environment === "cloud" && workspace?.networkAllow != null && explicit.success && explicit.data.network === void 0) permissions.network = "ask";
  const teamGuidance = team?.guidance;
  const workspaceGuidance = workspace?.guidance ?? null;
  const fromTeam = teamGuidance !== null && teamGuidance !== void 0;
  const text2 = (fromTeam ? teamGuidance : workspaceGuidance)?.trim() ?? "";
  return {
    policy: {
      permissions,
      networkAllow: resolveNetworkAllow(workspace?.networkAllow)
    },
    guidance: text2 ? text2 : null,
    guidanceFrom: text2 ? fromTeam ? "team" : "workspace" : null
  };
}
function defaultRunPolicy() {
  return resolveAgentSettings(null).policy;
}
function runPolicyDigestInput(policy) {
  const resolved = runPolicySchema.parse(policy ?? defaultRunPolicy());
  return JSON.stringify(resolved, [...Object.keys(resolved), ...Object.keys(resolved.permissions)].sort());
}

// ../protocol/src/policy-snapshot.ts
var POLICY_SNAPSHOT_HEADER = "x-mikka-policy-snapshot";
var POLICY_SNAPSHOT_VERSION = "1";
var POLICY_SNAPSHOT_TTL_MS = 5 * 6e4;
var POLICY_SNAPSHOT_REFRESH_MS = 3e4;
var id = z3.string().min(1).max(128);
var digest = z3.string().regex(/^[a-f0-9]{64}$/);
var policyScopeSchema = z3.strictObject({
  workspaceIds: z3.array(id).max(2),
  hierarchy: z3.strictObject({ workspaceId: z3.uuid(), teamId: z3.uuid(), projectId: z3.uuid().nullable() }).nullable()
});
var policySnapshotPayloadSchema = z3.strictObject({
  version: z3.literal(1),
  issuer: z3.url().max(1e3),
  ownerId: id,
  deviceId: id,
  runId: id,
  revision: digest,
  policyHash: digest,
  scope: policyScopeSchema,
  policy: runPolicySchema,
  issuedAt: z3.number().int().nonnegative(),
  expiresAt: z3.number().int().nonnegative()
});
var signedPolicySnapshotSchema = z3.strictObject({
  algorithm: z3.literal("Ed25519"),
  keyId: digest,
  payload: policySnapshotPayloadSchema,
  signature: z3.string().regex(/^[A-Za-z0-9_-]{86}$/)
});
var policyDistributionContextSchema = z3.strictObject({
  version: z3.literal(1),
  algorithm: z3.literal("Ed25519"),
  keyId: digest,
  publicKey: z3.string().regex(/^[A-Za-z0-9_-]{59}$/),
  issuer: z3.url().max(1e3),
  ownerId: id,
  deviceId: id,
  runId: id,
  revision: digest,
  scope: policyScopeSchema,
  required: z3.boolean()
});
function policyIssuer(base) {
  const url = new URL(base);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw Error("policyIssuerInvalid");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
function policySnapshotMessage(payload) {
  return new TextEncoder().encode(JSON.stringify(policySnapshotPayloadSchema.parse(payload)));
}

// ../protocol/src/node-policy-snapshot.ts
import { Buffer as Buffer2 } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
var policySnapshotHash = (policy) => createHash("sha256").update(runPolicyDigestInput(policy)).digest("hex");
function verifyPolicySnapshot(value, trusted, expected, options = {}) {
  const context = policyDistributionContextSchema.parse(trusted);
  const snapshot = signedPolicySnapshotSchema.parse(value), p = snapshot.payload, now = options.now ?? Date.now();
  if (policyIssuer(context.issuer) !== context.issuer || policyIssuer(p.issuer) !== context.issuer || p.ownerId !== context.ownerId || p.deviceId !== context.deviceId || p.runId !== context.runId || p.revision !== context.revision || p.policyHash !== policySnapshotHash(p.policy) || p.runId !== expected.runId || p.deviceId !== expected.deviceId || p.revision !== expected.revision || snapshot.keyId !== context.keyId || JSON.stringify(p.scope) !== JSON.stringify(context.scope) || expected.policy && JSON.stringify(p.policy) !== JSON.stringify(runPolicySchema.parse(expected.policy))) throw Error("policySnapshotBindingInvalid");
  if (p.issuedAt > now + 3e4 || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > POLICY_SNAPSHOT_TTL_MS || !options.allowExpired && p.expiresAt <= now) throw Error("policySnapshotExpired");
  const der = Buffer2.from(context.publicKey, "base64url");
  if (createHash("sha256").update(der).digest("hex") !== context.keyId || !verify(null, policySnapshotMessage(p), createPublicKey({ key: der, type: "spki", format: "der" }), Buffer2.from(snapshot.signature, "base64url"))) throw Error("policySnapshotSignatureInvalid");
  return snapshot;
}

// ../protocol/src/skill.ts
import { z as z5 } from "zod";

// ../protocol/src/skill-artifact.ts
import { z as z4 } from "zod";
var SKILL_ARTIFACT_HEADER = "x-mikka-skill-artifacts";
var TEAM_SKILL_HEADER = "x-mikka-team-skills";
var skillArtifactRefSchema = z4.object({
  schemaVersion: z4.literal(1),
  registryId: z4.enum(["mikka-builtin", "mikka-team"]),
  skillId: z4.uuid(),
  versionId: z4.uuid(),
  format: z4.literal("single-skill-md-v1"),
  sha256: z4.string().regex(/^[a-f0-9]{64}$/)
}).strict();
var skillAssignmentReceiptSchema = z4.object({
  id: z4.uuid(),
  runId: z4.uuid(),
  issueId: z4.uuid(),
  agentId: z4.uuid(),
  repoId: z4.uuid(),
  deviceId: z4.uuid(),
  leaseExpiresAt: z4.iso.datetime(),
  assignedAt: z4.iso.datetime(),
  artifact: skillArtifactRefSchema
}).strict();
var skillReceiptRevalidationSchema = z4.object({
  skillReceipt: skillAssignmentReceiptSchema,
  leaseExpiresAt: z4.iso.datetime()
}).strict();

// ../protocol/src/skill.ts
var MAX_SKILLS_PER_RUN = 20;
var MAX_SKILL_NAME_LENGTH = 80;
var MAX_SKILL_DESCRIPTION_LENGTH = 500;
var MAX_SKILL_INSTRUCTIONS_LENGTH = 2e4;
var MAX_SKILL_FILES = 20;
var MAX_SKILL_FILE_PATH_LENGTH = 200;
var MAX_SKILL_FILE_CONTENT_LENGTH = 1e5;
var skillFilePathSchema = z5.string().min(1).max(MAX_SKILL_FILE_PATH_LENGTH).refine(
  (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((segment) => segment === ".." || segment === ""),
  { message: "A skill file path must be relative and stay inside the skill." }
);
var skillFileSchema = z5.object({
  path: skillFilePathSchema,
  content: z5.string().max(MAX_SKILL_FILE_CONTENT_LENGTH)
});
var skillFilesSchema = z5.array(skillFileSchema).max(MAX_SKILL_FILES);
var skillNameSchema = z5.string().trim().min(1).max(MAX_SKILL_NAME_LENGTH);
var skillDescriptionSchema = z5.string().trim().max(MAX_SKILL_DESCRIPTION_LENGTH);
var skillInstructionsSchema = z5.string().trim().min(1).max(MAX_SKILL_INSTRUCTIONS_LENGTH);
var runSkillSchema = z5.object({
  id: z5.uuid(),
  name: skillNameSchema,
  description: z5.string().nullable(),
  instructions: skillInstructionsSchema,
  files: skillFilesSchema
});
var runSkillRefSchema = z5.object({
  id: z5.uuid(),
  name: skillNameSchema
});

// ../protocol/src/subscription.ts
import { z as z7 } from "zod";

// ../protocol/src/quota.ts
import { z as z6 } from "zod";
var QUOTA_VENDORS = ["claude_code", "codex", "cursor"];
var quotaVendorSchema = z6.enum(QUOTA_VENDORS);
var QUOTA_SOURCES = ["local_credentials", "official"];
var quotaSourceSchema = z6.enum(QUOTA_SOURCES);
var QUOTA_WINDOW_KINDS = [
  "five_hour",
  "weekly",
  "monthly",
  "daily",
  "hourly",
  "other"
];
var quotaWindowKindSchema = z6.enum(QUOTA_WINDOW_KINDS);
var QUOTA_METERS = [
  "auto",
  "api",
  "on_demand",
  "team_pool",
  "team_on_demand"
];
var quotaMeterSchema = z6.enum(QUOTA_METERS);
var quotaWindowSchema = z6.object({
  kind: quotaWindowKindSchema,
  /** 0..1 share of the window already used. */
  used: z6.number().min(0).max(1),
  resetsAt: z6.string().nullable(),
  /** Model display name for a per-model window, e.g. "Opus". */
  model: z6.string().min(1).max(40).optional(),
  meter: quotaMeterSchema.optional()
});
var quotaSnapshotSchema = z6.object({
  vendor: quotaVendorSchema,
  source: quotaSourceSchema,
  status: z6.enum(["ok", "unknown"]),
  plan: z6.string().max(40).nullable(),
  windows: z6.array(quotaWindowSchema).max(12),
  /** When this vendor was last read (ISO-8601). */
  observedAt: z6.string()
});
var quotaSnapshotReportSchema = z6.object({
  /** When the whole read finished. Null before the first read. */
  observedAt: z6.string().nullable(),
  quotas: z6.array(quotaSnapshotSchema).max(6)
});

// ../protocol/src/subscription.ts
var id2 = z7.string().min(1).max(128);
var subscriptionRouteSchema = z7.enum([
  "codex_cli",
  "claude_code_cli",
  "codex_cpa",
  "claude_cpa",
  "openai_siwc"
]);
var subscriptionConnectionSchema = z7.object({
  id: id2,
  ownerId: id2,
  workspaceId: id2,
  provider: z7.enum(["openai", "anthropic"]),
  state: z7.enum([
    "pending",
    "connected",
    "reconnect_required",
    "disconnected"
  ]),
  // Increment on reconnect/disconnect. Old bindings cannot become valid again.
  revision: z7.number().int().positive(),
  quota: quotaSnapshotSchema
}).strict();
var subscriptionBindingSchema = z7.object({
  id: id2,
  ownerId: id2,
  workspaceId: id2,
  // An agent or assistant session selected explicitly by the owner.
  consumerId: id2,
  connectionId: id2,
  connectionRevision: z7.number().int().positive(),
  route: subscriptionRouteSchema
}).strict();
var nativeBrokerContextSchema = z7.object({
  route: z7.enum(["codex_cli", "claude_code_cli"]),
  modelId: z7.string().min(1).max(128),
  revision: z7.number().int().positive(),
  accountId: z7.string().min(1).max(512),
  plan: z7.string().max(40).optional(),
  expiresAt: z7.iso.datetime()
}).strict();
var nativeLeaseSchema = nativeBrokerContextSchema.extend({
  accessToken: z7.string().min(1).max(32768).regex(/^[^\r\n\0]+$/)
}).strict();

// ../protocol/src/computer.ts
import { z as z8 } from "zod";
var machineStateSchema = z8.enum(["sleeping", "waking", "running", "error"]);
var controlStateSchema = z8.enum(["agent", "user", "idle"]);
var computerToolSchema = z8.enum(["click", "type", "key", "scroll", "screenshot"]);
var screenRectSchema = z8.object({ x: z8.number(), y: z8.number(), w: z8.number().nonnegative(), h: z8.number().nonnegative() });
var computerActionSchema = z8.object({ tool: computerToolSchema, x: z8.number().optional(), y: z8.number().optional(), text: z8.string().optional(), rect: screenRectSchema.optional() });
var lastActionSchema = computerActionSchema.omit({ text: true }).extend({ at: z8.iso.datetime() });
var approvalViewSchema = z8.object({
  id: z8.string(),
  digest: z8.string(),
  runId: z8.string(),
  botId: z8.string(),
  action: computerActionSchema,
  summary: z8.string(),
  expiresAt: z8.iso.datetime()
});
var computerStateSchema = z8.object({
  machine: machineStateSchema,
  control: controlStateSchema,
  controlledBy: z8.object({ userId: z8.string() }).optional(),
  lastAction: lastActionSchema.optional(),
  pendingApproval: approvalViewSchema.optional()
});
var viewerModeSchema = z8.enum(["view", "control"]);
var viewerRequestSchema = z8.object({ mode: viewerModeSchema }).strict();
var viewerGrantSchema = z8.object({ url: z8.url({ protocol: /^wss$/ }), expiresAt: z8.iso.datetime() });
var createBotSchema = z8.object({ name: z8.string().trim().min(1).max(120) }).strict();
var botViewSchema = z8.object({ id: z8.uuid(), name: z8.string().min(1).max(120) });
var approvalDecisionSchema = z8.object({ digest: z8.string(), decision: z8.enum(["approve", "deny"]), scope: z8.enum(["once", "run"]) }).strict();
var computerTaskStateSchema = z8.enum(["working", "approval", "done", "failed"]);
var computerTaskSchema = z8.object({ botId: z8.string(), runId: z8.string(), task: z8.string(), state: computerTaskStateSchema, approvalId: z8.string().optional() });
var computerEventSchema = z8.discriminatedUnion("type", [
  z8.object({ type: z8.literal("computer.machine"), state: machineStateSchema }),
  z8.object({ type: z8.literal("computer.control"), botId: z8.string(), control: controlStateSchema, controlledBy: z8.object({ userId: z8.string() }).optional() }),
  z8.object({ type: z8.literal("computer.action"), botId: z8.string(), lastAction: lastActionSchema }),
  z8.object({ type: z8.literal("computer.approval"), botId: z8.string(), approval: approvalViewSchema.nullable() })
]);
var reviewDigestSchema = z8.string().regex(/^[a-f0-9]{64}$/);
var localComputerCall = z8.discriminatedUnion("name", [
  z8.object({ name: z8.literal("get_desktop_state"), arguments: z8.object({}).strict() }).strict(),
  z8.object({ name: z8.literal("click"), arguments: z8.object({ x: z8.number().int().min(0).max(1e5), y: z8.number().int().min(0).max(1e5) }).strict() }).strict(),
  z8.object({ name: z8.literal("type_text"), arguments: z8.object({ text: z8.string().min(1).max(8e3) }).strict() }).strict(),
  z8.object({ name: z8.literal("press_key"), arguments: z8.object({
    key: z8.string().regex(/^(?:[\x20-\x7e]|enter|return|tab|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))$/),
    modifiers: z8.array(z8.enum(["ctrl", "shift", "alt", "super"])).max(4).refine((items) => new Set(items).size === items.length).optional()
  }).strict() }).strict(),
  z8.object({ name: z8.literal("scroll"), arguments: z8.object({ direction: z8.enum(["up", "down", "left", "right"]), amount: z8.number().int().min(1).max(50), x: z8.number().int().min(0).max(1e5), y: z8.number().int().min(0).max(1e5) }).strict() }).strict()
]);
var localComputerRequest = z8.object({
  id: z8.uuid(),
  runId: z8.uuid(),
  target: reviewDigestSchema,
  display: z8.string().regex(/^:[1-9][0-9]{0,2}$/).optional(),
  call: localComputerCall,
  expiresAt: z8.number().int().positive(),
  digest: reviewDigestSchema
}).strict();
var localComputerDecision = z8.object({ id: z8.uuid(), digest: reviewDigestSchema, approve: z8.boolean() }).strict();
var computerSyncBody = z8.object({ requests: z8.array(localComputerRequest).max(20) }).strict();
var computerSyncResponse = z8.object({ decisions: z8.array(localComputerDecision).max(20) }).strict();
var computerSyncPath = (deviceId) => `/v1/devices/${encodeURIComponent(deviceId)}/computer`;

// ../protocol/src/capture.ts
import { z as z9 } from "zod";
var CAPTURE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm"
];
var CAPTURE_KINDS = ["image", "video"];
var CAPTURE_SOURCES = ["cloud_computer", "local"];
var CAPTURE_MAX_BYTES = {
  image: 1e7,
  video: 1e8
};
var RECORDING_MAX_SECONDS = 300;
var CAPTURE_TITLE_MAX = 200;
var sha256 = z9.string().regex(/^[a-f0-9]{64}$/);
var title = z9.string().trim().min(1).max(CAPTURE_TITLE_MAX);
var captureUploadRequest = z9.object({
  /** Stable client id, persisted before the first network attempt. */
  captureId: z9.uuid().optional(),
  title,
  contentType: z9.enum(CAPTURE_CONTENT_TYPES),
  size: z9.number().int().min(1).max(CAPTURE_MAX_BYTES.video),
  sha256
}).strict();
var captureUploadTarget = z9.discriminatedUnion("target", [
  z9.object({ target: z9.literal("storage"), url: z9.url({ protocol: /^https$/ }), headers: z9.record(z9.string(), z9.string()) }),
  z9.object({ target: z9.literal("server") })
]);
var captureUploadResponse = z9.object({
  captureId: z9.uuid(),
  upload: captureUploadTarget
});
var captureView = z9.object({
  id: z9.uuid(),
  kind: z9.enum(CAPTURE_KINDS),
  contentType: z9.enum(CAPTURE_CONTENT_TYPES),
  title: z9.string(),
  size: z9.number().int().nonnegative(),
  durationMs: z9.number().int().nonnegative().nullable(),
  source: z9.enum(CAPTURE_SOURCES),
  createdAt: z9.iso.datetime()
});
var captureCompleteResponse = z9.object({ capture: captureView });
var screenCaptureRequest = z9.discriminatedUnion("action", [
  z9.object({ action: z9.literal("screenshot"), title }).strict(),
  z9.object({ action: z9.literal("start_recording"), title, maxSeconds: z9.number().int().min(5).max(RECORDING_MAX_SECONDS).optional() }).strict(),
  z9.object({ action: z9.literal("stop_recording") }).strict(),
  // A step on the recording's timeline: an action's own description, or a moment the agent marks.
  z9.object({ action: z9.literal("step"), label: title, source: z9.enum(["action", "mark"]) }).strict()
]);
var screenCaptureResponse = z9.discriminatedUnion("action", [
  z9.object({ action: z9.literal("screenshot"), capture: captureView }),
  z9.object({ action: z9.literal("start_recording"), recordingId: z9.uuid(), stopsAt: z9.iso.datetime() }),
  z9.object({ action: z9.literal("stop_recording"), capture: captureView }),
  z9.object({ action: z9.literal("step"), recorded: z9.boolean() })
]);
var capturePaths = {
  begin: (runId) => `/v1/runs/${encodeURIComponent(runId)}/captures`,
  upload: (runId, captureId) => `/v1/runs/${encodeURIComponent(runId)}/captures/${encodeURIComponent(captureId)}`,
  complete: (runId, captureId) => `/v1/runs/${encodeURIComponent(runId)}/captures/${encodeURIComponent(captureId)}/complete`,
  screen: (runId) => `/v1/runs/${encodeURIComponent(runId)}/screen`
};

// ../protocol/src/accounts.ts
import { z as z10 } from "zod";
var connectedAccount = z10.object({
  /** The provider, e.g. "github". Unique per person, so it names the row. */
  providerId: z10.string(),
  /**
   * The account's id at the provider. Better Auth stores the provider's own
   * user id here, which for GitHub is a number — the closest thing to a
   * display name the table holds.
   */
  accountId: z10.string(),
  /** OAuth scopes granted, space separated. Null when the provider sent none. */
  scope: z10.string().nullable(),
  /** When the account was linked, ISO 8601. */
  createdAt: z10.string()
});
var connectedAccountsResponse = z10.object({
  accounts: z10.array(connectedAccount)
});

// ../protocol/src/auth.ts
import { z as z11 } from "zod";
var AUTH_PROVIDERS = ["github", "google"];
var authProvider = z11.enum(AUTH_PROVIDERS);
var DESKTOP_SCHEMES = ["mikka", "mikka-dev"];
var desktopScheme = z11.enum(DESKTOP_SCHEMES);
var AUTH_BASE_PATH = "/api/auth";
var AUTH_ROUTES = {
  /** Better Auth jwt plugin: short-lived JWT for zero-cache and the relay. */
  token: `${AUTH_BASE_PATH}/token`,
  /** Dev-only bypass (a Better Auth endpoint, so it sets the session cookie). */
  devLogin: `${AUTH_BASE_PATH}/dev/login`,
  me: "/v1/me"
};
var activeSession = z11.object({
  id: z11.string(),
  /** ISO timestamps. */
  createdAt: z11.string(),
  expiresAt: z11.string(),
  ipAddress: z11.string().nullable(),
  userAgent: z11.string().nullable(),
  /** Derived from the caller's JWT (`sid`), not from the request's cookies. */
  current: z11.boolean()
});
var activeSessions = z11.object({ sessions: z11.array(activeSession) });
var authorizedDevice = z11.object({
  id: z11.uuid(),
  name: z11.string(),
  hostname: z11.string().nullable(),
  platform: z11.string().nullable(),
  daemonVersion: z11.string().nullable(),
  lastSeenAt: z11.string().nullable(),
  /** The daemon session; null once the authorization is revoked. */
  sessionId: z11.string().nullable(),
  /** When the daemon signed in, and when that session expires. */
  authorizedAt: z11.string().nullable(),
  expiresAt: z11.string().nullable()
});
var authorizedDevices = z11.object({
  devices: z11.array(authorizedDevice)
});
var authorizedApplication = z11.object({
  id: z11.string(),
  name: z11.string(),
  uri: z11.string().nullable(),
  scopes: z11.array(z11.string()),
  createdAt: z11.string(),
  updatedAt: z11.string()
});
var authorizedApplications = z11.object({
  applications: z11.array(authorizedApplication)
});
var sessionUser = z11.object({
  id: z11.uuid(),
  email: z11.string(),
  name: z11.string(),
  image: z11.string().nullable()
});
var accessToken = z11.object({
  token: z11.string().min(1),
  /** Expiry, ms since epoch (from the JWT's `exp`). */
  expiresAt: z11.number().int()
});

// ../protocol/src/bridge.ts
import { z as z12 } from "zod";
var LANGUAGES = ["zh-CN", "en"];
var languagePreference = z12.enum(["system", ...LANGUAGES]);
var themePreference = z12.enum(["system", "light", "dark"]);
var appHref = z12.string().max(2048).regex(/^\/(?!\/)/);
var DESKTOP_NOTIFICATION_KINDS = [
  "review",
  "awaiting",
  "failed",
  "finished"
];
var desktopNotification = z12.object({
  /** The `notification` row id. */
  id: z12.string().min(1).max(200),
  kind: z12.enum(DESKTOP_NOTIFICATION_KINDS),
  /** `ORV-12 · 等你验收`; the issue number is always in it. */
  title: z12.string().min(1).max(300),
  /** The issue title. */
  body: z12.string().max(1e3),
  href: appHref
});
var desktopBadgeCount = z12.number().int().min(0).max(9999);
var savedTab = z12.object({
  entries: z12.array(appHref).min(1).max(50),
  index: z12.number().int().min(0).max(49)
});
var savedTabs = z12.object({
  items: z12.array(savedTab).max(50),
  active: z12.number().int().min(0).max(49)
});
var firstDayOfWeekPreference = z12.enum(["monday", "sunday", "saturday"]);
var commentSubmitKeyPreference = z12.enum(["mod+enter", "enter"]);
var settingsSchema = z12.object({
  language: languagePreference,
  theme: themePreference,
  /** Sidebar expanded (true) or collapsed offcanvas (false); ⌘B and `[`. */
  sidebarOpen: z12.boolean(),
  /** Titlebar tabs; empty until the app has saved them once. */
  tabs: savedTabs,
  /** Send anonymous usage events (ADR 0033); off by choice in Settings. */
  telemetry: z12.boolean(),
  /** Which day a week starts on in date pickers. */
  firstDayOfWeek: firstDayOfWeekPreference,
  /** Which key press sends a comment. */
  commentSubmitKey: commentSubmitKeyPreference
});
var DEFAULT_SETTINGS = {
  language: "system",
  theme: "system",
  sidebarOpen: true,
  tabs: { items: [], active: 0 },
  telemetry: true,
  firstDayOfWeek: "monday",
  commentSubmitKey: "mod+enter"
};
var SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
var authState = z12.discriminatedUnion("status", [
  z12.object({ status: z12.literal("signed_out") }),
  z12.object({ status: z12.literal("signing_in"), provider: authProvider }),
  z12.object({ status: z12.literal("signed_in"), user: sessionUser }),
  z12.object({
    status: z12.literal("update_required"),
    minVersion: z12.string()
  }),
  z12.object({ status: z12.literal("error"), code: z12.string() })
]);
var localDevice = z12.object({
  /** Whether the daemon on this computer answers. */
  status: z12.enum(["online", "connecting", "offline"]),
  /** The device row this daemon registered, once it has. */
  deviceId: z12.string().nullable(),
  workspaceId: z12.string().nullable(),
  /** The daemon holds a device credential. */
  signedIn: z12.boolean(),
  /** The daemon's link to the server; null while the daemon is offline. */
  server: z12.enum(["online", "offline", "unregistered"]).nullable()
});
var deviceLinkRequest = z12.object({ workspaceId: z12.uuid() });
var pickedRepo = z12.object({
  /** The repo's top level (a subfolder pick resolves to it). */
  path: z12.string().min(1).max(4e3),
  name: z12.string().max(500),
  /** `origin` (or the first remote), null when the repo has none. */
  remoteUrl: z12.string().max(2e3).nullable()
});
var pickRepoResult = z12.discriminatedUnion("status", [
  z12.object({ status: z12.literal("picked"), repo: pickedRepo }),
  z12.object({ status: z12.literal("cancelled") }),
  z12.object({ status: z12.literal("not_a_repo"), path: z12.string() })
]);

// ../protocol/src/cycles.ts
import { z as z13 } from "zod";
var WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
];
var CYCLE_DURATION_MIN_DAYS = 1;
var CYCLE_DURATION_MAX_DAYS = 56;
var CYCLE_UPCOMING_MAX = 8;
var teamCycleSettingsSchema = z13.object({
  /** Off until a person turns it on: nothing is created and nothing rolls. */
  enabled: z13.boolean().default(false),
  /** Length of a cycle in days; the end date is `start + duration - 1`. */
  durationDays: z13.number().int().min(CYCLE_DURATION_MIN_DAYS).max(CYCLE_DURATION_MAX_DAYS).default(14),
  /** The weekday a team's first cycle starts on. */
  startWeekday: z13.enum(WEEKDAYS).default("monday"),
  /** Cycles kept ready ahead of the current one. 0 creates them just in time. */
  upcomingCount: z13.number().int().min(0).max(CYCLE_UPCOMING_MAX).default(1),
  /**
   * When a cycle ends, unfinished issues move to the next one. Off leaves them
   * in the finished cycle, which is what `cycle.complete` has always done.
   */
  autoRollover: z13.boolean().default(true),
  /**
   * The team's calendar. A cycle ends at the last moment of its end date
   * *here*, not in UTC, so a team in Auckland and one in Los Angeles roll over
   * at different instants.
   */
  timezone: z13.string().max(64).refine(isValidTimeZone, "Unknown timezone.").default("UTC")
});
function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ../protocol/src/daemon.ts
import { z as z17 } from "zod";

// ../protocol/src/harness.ts
import { z as z14 } from "zod";
var HARNESSES = ["claude_code", "codex", "cursor", "mock"];
var harnessSchema = z14.enum(HARNESSES);
var harnessInfoSchema = z14.object({
  harness: harnessSchema,
  installed: z14.boolean(),
  models: z14.array(z14.string().trim().min(1).max(128)).max(500).optional(),
  modelSlots: z14.array(
    z14.object({
      slot: z14.string().trim().min(1).max(128).refine((v2) => v2 !== "auto"),
      model: z14.string().trim().min(1).max(128),
      name: z14.string().trim().min(1).max(200)
    })
  ).max(500).optional(),
  defaultModelSlot: z14.string().trim().min(1).max(128).optional(),
  /** Deprecated (#312, 2026-10-27): could host the native Coordinator. The server keeps that runtime switched off. */
  coordinator: z14.boolean().optional(),
  /**
   * Set only by a runner that runs subscriptions under owner-bound custody:
   * the hosted runner's broker, or a device daemon that takes one run's
   * short-lived access lease (never the refresh grant) and wipes it at run end.
   */
  subscriptionBroker: z14.literal(true).optional(),
  /** Set only by an E2B worker with the guarded Bot computer broker. */
  computerBroker: z14.literal(true).optional(),
  /** Run-scoped CLI approvals and policy-version checks are supported. */
  toolApproval: z14.literal(true).optional(),
  /**
   * The CLI exists but `installed` stays false because the daemon cannot run it
   * in a sandbox. `missing` names the absent packages; empty means the machine
   * itself refused isolation. `reason` names a refusal the person can lift
   * (`userns_restricted`: Ubuntu's AppArmor user namespace restriction), and
   * `detail` is the probe's own error, already sanitized by the daemon.
   */
  sandboxBlocked: z14.object({
    missing: z14.array(z14.string().trim().min(1).max(64)).max(8),
    reason: z14.enum(["userns_restricted"]).optional(),
    detail: z14.string().max(300).optional()
  }).optional(),
  /** Version string reported by the CLI, null when not installed. */
  version: z14.string().nullable()
});

// ../protocol/src/run.ts
import { z as z16 } from "zod";

// ../protocol/src/plan.ts
import { z as z15 } from "zod";
var text = (max) => z15.string().trim().min(1).max(max);
var key = z15.string().trim().min(1).max(64);
var planSection = z15.object({
  heading: text(200),
  items: z15.array(text(2e3)).min(1).max(50)
});
var planSpec = z15.object({
  title: text(500),
  summary: z15.string().trim().max(4e3).default(""),
  sections: z15.array(planSection).min(1).max(30)
});
var planCriterion = z15.object({
  body: text(2e3),
  /** The command that checks it; absent means a person checks it. */
  checkCommand: z15.string().trim().max(2e3).optional()
});
var PLAN_PRIORITIES = [
  "none",
  "urgent",
  "high",
  "medium",
  "low"
];
var planIssue = z15.object({
  key,
  title: text(500),
  goal: z15.string().trim().max(4e3).optional(),
  /** Grouping only; order lives in `blockedBy` (`issue.parent_id`). */
  parentKey: key.optional(),
  blockedBy: z15.array(key).max(50).default([]),
  criteria: z15.array(planCriterion).min(1).max(50),
  verifyCommand: z15.string().trim().max(2e3).optional(),
  predictedFiles: z15.array(z15.string().trim().max(1e3)).max(200).default([]),
  sizeEstimate: z15.object({ files: z15.number().int().min(0), lines: z15.number().int().min(0) }).optional(),
  priority: z15.enum(PLAN_PRIORITIES).default("none")
});
var planSplit = z15.object({
  summary: z15.string().trim().max(4e3).default(""),
  issues: z15.array(planIssue).min(1).max(100)
});
var planHandoff = z15.object({
  specId: z15.uuid(),
  spec: planSpec,
  split: planSplit
});

// ../protocol/src/run.ts
var RUN_QUESTION_KINDS = [
  "context",
  "decision",
  "permission",
  "external"
];
var runQuestion = z16.object({
  questionId: z16.uuid(),
  kind: z16.enum(RUN_QUESTION_KINDS).default("decision"),
  question: z16.string().trim().min(1).max(4e3),
  context: z16.string().trim().max(4e3).optional(),
  options: z16.array(z16.string().trim().min(1).max(4e3)).max(20).default([])
}).strict();
var RUN_STOP_REASONS = [
  "submitted",
  "turn_ended",
  "asked_human",
  "blocked",
  "cancelled",
  "error",
  "timeout",
  "device_lost",
  /** The subscription's quota or rate limit ran out mid-run (see `resetsAt`). */
  "quota_exhausted"
];
var runStopReason = z16.enum(RUN_STOP_REASONS);
var shortList = z16.array(z16.string().max(1e3)).max(5e3);
var VERIFY_STATUSES = ["passed", "failed", "not_run"];
var verifyStatus = z16.enum(VERIFY_STATUSES);
var runPublish = z16.object({
  /** Where the commit went: the issue's branch, or the run's own. */
  branch: z16.string().max(500),
  /** Null when nothing was committed (no changes, or the commit failed). */
  commit: z16.string().max(100).nullable(),
  pushed: z16.boolean(),
  remote: z16.string().max(200).nullable(),
  /**
   * Why nothing was pushed when that was expected: the agent changed
   * nothing, or the repo has not approved pushes. Absent with
   * `pushed: false` means the commit or the push failed (see `note`).
   */
  skipped: z16.enum(["no_changes", "not_approved"]).optional(),
  note: z16.string().max(2e3).optional()
});
var runBenchmarkContext = z16.object({
  sourceCommit: z16.string().regex(/^[a-f0-9]{40}$/),
  benchmarkDigest: z16.string().regex(/^[a-f0-9]{64}$/),
  caseId: z16.string().min(1).max(200),
  fixtureDigest: z16.string().regex(/^[a-f0-9]{64}$/),
  policyDigest: z16.string().regex(/^[a-f0-9]{64}$/)
}).strict();
var runExecution = runBenchmarkContext.extend({
  harness: z16.enum(["codex", "claude_code", "cursor"]),
  requestedModel: z16.string().min(1).max(500).nullable(),
  observedModel: z16.string().min(1).max(500).nullable(),
  verifyCommand: z16.string().min(1).max(2e3)
}).strict();
var runRuntime = runExecution.pick({
  harness: true,
  requestedModel: true,
  observedModel: true,
  policyDigest: true,
  sourceCommit: true
}).strict();
var runSkillMount = z16.object({
  receiptId: z16.uuid(),
  versionId: z16.uuid(),
  sha256: z16.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z16.string().min(1).max(500),
  mountedAt: z16.iso.datetime()
}).strict();
var runReport = z16.object({
  /** Worktree base journaled before the adapter started; never agent-supplied. */
  sourceCommit: z16.string().regex(/^[a-f0-9]{40}$/).optional(),
  skillMount: runSkillMount.optional(),
  execution: runExecution.optional(),
  runtime: runRuntime.optional(),
  /** What was done, in a few sentences. Empty when the run crashed early. */
  summary: z16.string().max(1e4),
  /** Paths relative to the worktree root (from `git status`). */
  filesChanged: shortList,
  /** The daemon's run of the issue's verify command after a submit. */
  verify: z16.object({
    status: verifyStatus,
    command: z16.string().max(2e3).optional(),
    /** Actual process outcome from the daemon, never the agent. */
    exitCode: z16.number().int().nullable().optional(),
    signal: z16.string().max(100).nullable().optional(),
    timedOut: z16.boolean().optional(),
    /** Tail of the command output. */
    output: z16.string().max(1e4).optional()
  }),
  openQuestions: z16.array(z16.string().max(2e3)).max(50),
  /** What should happen next, from the agent's point of view. */
  question: runQuestion.optional(),
  nextStep: z16.string().max(2e3).nullable(),
  /** For `blocked`: the external condition, e.g. `quota_exhausted`. */
  blockedOn: z16.string().max(500).optional(),
  /**
   * For `quota_exhausted`: when the subscription's quota resets, as the CLI
   * reported it; null when it gave no time. Set by the daemon only.
   */
  resetsAt: z16.iso.datetime({ offset: true }).nullable().optional(),
  /** Daemon-owned receipt for an exact, unchanged read-only candidate. */
  check: z16.object({
    sha: z16.string().regex(/^[a-f0-9]{40}$/),
    readOnly: z16.literal(true)
  }).optional(),
  /** Preview branch created or used by the producing run; descriptive metadata only. */
  previewDatabaseBranch: z16.string().trim().min(1).max(500).optional(),
  /** Acceptance criteria the agent checked, with evidence. */
  criteria: z16.array(
    z16.object({
      criterionId: z16.uuid().optional(),
      text: z16.string().max(2e3).optional(),
      passed: z16.boolean(),
      evidence: z16.string().max(1e4).optional(),
      /** Agent-reported criterion check; the daemon-owned verify remains authoritative. */
      command: z16.string().trim().min(1).max(2e3).optional(),
      exitCode: z16.number().int().nullable().optional()
    })
  ).max(200).optional(),
  /**
   * A `plan` run's hand-in: the spec it wrote and the split it proposes for
   * it (ADR ORV-205). Only the daemon sets this, and only for a `plan` run.
   */
  plan: planHandoff.optional(),
  interfacesProduced: shortList.optional(),
  knownIssues: shortList.optional(),
  notesForNext: z16.string().max(1e4).optional(),
  /** Set by the daemon after a verified submit; never by the agent. */
  publish: runPublish.optional(),
  followUps: z16.array(
    z16.object({
      title: z16.string().trim().min(1).max(500),
      goal: z16.string().max(2e3).optional(),
      reason: z16.string().max(2e3).optional()
    })
  ).max(50).optional()
});
var runCompletePath = (runId) => `/v1/runs/${encodeURIComponent(runId)}/complete`;
var runCompletion = z16.object({
  stopReason: runStopReason,
  report: runReport
});
var runCompleteRequest = z16.object({ stopReason: runStopReason, report: runReport.optional() }).refine((body) => body.stopReason !== "submitted" || body.report, {
  message: "A submitted run needs a report.",
  path: ["report"]
});

// ../protocol/src/daemon.ts
var RUN_STATES = [
  "queued",
  "preparing",
  "running",
  "waiting_input",
  "finishing",
  "succeeded",
  /** Ended without success or failure: the turn ended, a question, a blocker. */
  "stopped",
  "failed",
  "cancelled"
];
var runStateSchema = z17.enum(RUN_STATES);
var stopReasonSchema = runStopReason;
var DAEMON_RPC_ERRORS = {
  handshakeRequired: 4001,
  protocolMismatch: 4002,
  unauthorized: 4003,
  repoNotAllowed: 4010,
  runNotFound: 4011,
  runNotPinnedHere: 4012,
  harnessNotSupported: 4013,
  invalidId: 4014,
  serverUnreachable: 4020,
  draining: 4030
};
var helloParams = z17.object({
  protocolVersion: z17.number().int(),
  /** Contents of the daemon's `daemon.secret` file in the flavor data dir. */
  secret: z17.string(),
  client: z17.object({ name: z17.string(), version: z17.string() })
});
var helloResult = z17.object({
  protocolVersion: z17.number().int(),
  daemonVersion: z17.string(),
  pid: z17.number().int()
});
var runSummarySchema = z17.object({
  runId: z17.string(),
  issueId: z17.string(),
  harness: harnessSchema,
  state: runStateSchema,
  worktree: z17.string().nullable(),
  sessionId: z17.string().nullable(),
  /** Chunks emitted so far (the daemon-local producer sequence). */
  chunks: z17.number().int().nonnegative(),
  error: z17.string().nullable(),
  /** Set once the run reached a terminal state. */
  stopReason: stopReasonSchema.optional(),
  /** Lease from the server; the daemon stops the run if it cannot renew it. */
  leaseExpiresAt: z17.string().optional(),
  /** Last progress seen by the watchdog (ISO time), while the run is active. */
  lastProgressAt: z17.string().optional()
});
var daemonStatusSchema = z17.object({
  daemonVersion: z17.string(),
  protocolVersion: z17.number().int(),
  pid: z17.number().int(),
  dataDir: z17.string(),
  /** Null until the device is registered with the server. */
  deviceId: z17.string().nullable(),
  /** The workspace the device credential was handed over for, if named. */
  workspaceId: z17.string().nullable(),
  /** Holds a device credential (it may still be refused by the server). */
  signedIn: z17.boolean(),
  server: z17.enum(["online", "offline", "unregistered"]),
  harnesses: z17.array(harnessInfoSchema),
  runs: z17.array(runSummarySchema),
  /** Bytes used by run worktrees under the daemon's data dir. */
  worktreeDiskBytes: z17.number().int().nonnegative(),
  /** Items buffered on disk, waiting for the server. */
  pendingUploads: z17.number().int().nonnegative(),
  draining: z17.boolean(),
  /** Latest subscription snapshots. Empty when quota polling is off. */
  quotas: z17.array(quotaSnapshotSchema).max(6)
});
var empty = z17.object({}).optional();
var ok = z17.object({ ok: z17.literal(true) });
var daemonRpc = {
  "daemon.hello": { params: helloParams, result: helloResult },
  "daemon.status": { params: empty, result: daemonStatusSchema },
  /** Cached subscription snapshots. Does not start a vendor request. */
  "quota.snapshot": { params: empty, result: quotaSnapshotReportSchema },
  /** Stop accepting runs, journal active ones for resume, then exit. */
  "daemon.drain": { params: empty, result: ok },
  /** Hand the daemon a device credential obtained by the signed-in desktop. */
  "device.setCredential": {
    params: z17.object({
      credential: z17.string().min(1),
      /** Needed only for users in more than one workspace. */
      workspaceId: z17.uuid().optional()
    }),
    result: ok
  },
  /** Forget the device credential (the person signed out of the app). */
  "device.clearCredential": { params: empty, result: ok },
  /** Claim a queued run pinned to this device and start it. */
  "runs.start": {
    params: z17.object({ runId: z17.string() }),
    result: runSummarySchema
  },
  "runs.list": { params: empty, result: z17.array(runSummarySchema) },
  /** Interject a user message into a running session. */
  "runs.send": {
    params: z17.object({ runId: z17.string(), text: z17.string().min(1) }),
    result: ok
  },
  "runs.cancel": {
    params: z17.object({ runId: z17.string() }),
    result: runSummarySchema
  },
  /**
   * Dev only (`mikka daemon --dev --server memory`): queue and start a mock
   * run on an allow-listed repo without a server. Refused otherwise.
   */
  "dev.mockRun": {
    params: z17.object({
      repoId: z17.string(),
      fixture: z17.string().optional(),
      baseBranch: z17.string().optional(),
      /** Run after the mock submits; defaults to `git diff --check`. */
      verifyCommand: z17.string().optional()
    }),
    result: runSummarySchema
  }
};

// ../protocol/src/device.ts
import { z as z18 } from "zod";
var id3 = z18.string().min(1).max(64);
var isoTime = z18.iso.datetime({ offset: true });
var seg = encodeURIComponent;
var DEVICE_ROUTES = {
  register: "/v1/devices/register",
  heartbeat: "/v1/devices/:deviceId/heartbeat",
  repos: "/v1/devices/:deviceId/repos",
  pendingRuns: "/v1/devices/:deviceId/runs",
  claim: "/v1/devices/:deviceId/runs/:runId/claim",
  commands: "/v1/devices/:deviceId/commands",
  commandsAck: "/v1/devices/:deviceId/commands/ack",
  runEvents: "/v1/runs/:runId/events",
  runPatch: "/v1/runs/:runId",
  runCheckpoint: "/v1/runs/:runId/checkpoint"
};
var devicePaths = {
  register: () => DEVICE_ROUTES.register,
  heartbeat: (deviceId) => `/v1/devices/${seg(deviceId)}/heartbeat`,
  repos: (deviceId) => `/v1/devices/${seg(deviceId)}/repos`,
  pendingRuns: (deviceId) => `/v1/devices/${seg(deviceId)}/runs?state=queued`,
  claim: (deviceId, runId) => `/v1/devices/${seg(deviceId)}/runs/${seg(runId)}/claim`,
  commands: (deviceId, waitSeconds, skipRuns = []) => `/v1/devices/${seg(deviceId)}/commands?wait=${waitSeconds}` + (skipRuns.length ? `&${COMMANDS_SKIP_PARAM}=${skipRuns.map(seg).join(",")}` : ""),
  commandsAck: (deviceId) => `/v1/devices/${seg(deviceId)}/commands/ack`,
  runEvents: (runId) => `/v1/runs/${seg(runId)}/events`,
  runPatch: (runId) => `/v1/runs/${seg(runId)}`,
  runCheckpoint: (runId) => `/v1/runs/${seg(runId)}/checkpoint`
};
var deviceComputerCapability = z18.object({ installed: z18.boolean(), version: z18.string().max(100).nullable() }).strict();
var deviceRunnerCapability = z18.object({
  os: z18.string().max(50),
  arch: z18.string().max(50),
  freeDiskBytes: z18.number().int().nonnegative().nullable(),
  docker: z18.boolean(),
  harnesses: z18.array(z18.object({
    harness: harnessSchema,
    state: z18.enum(["installed", "not_installed", "unsupported"]),
    version: z18.string().max(100)
  })).max(20)
});
var deviceRegistration = z18.object({
  deviceType: z18.enum(["laptop", "server"]).optional(),
  name: z18.string().trim().min(1).max(200),
  hostname: z18.string().max(255).nullable().optional(),
  platform: z18.string().max(50),
  arch: z18.string().max(50),
  daemonVersion: z18.string().max(50),
  protocolVersion: z18.number().int(),
  harnesses: z18.array(harnessInfoSchema).max(20),
  computerUse: deviceComputerCapability.optional(),
  runner: deviceRunnerCapability.optional(),
  /**
   * This machine's one device id, the same in every workspace (ADR ORV-284).
   * Registering with it in another workspace joins the same device there.
   * An id the server does not know yet becomes the new device's id; another
   * person's id registers a new device.
   */
  deviceId: id3.optional(),
  /** Needed only when the user belongs to more than one workspace. */
  workspaceId: z18.uuid().optional()
});
var deviceRegistered = z18.object({
  deviceId: id3,
  workspaceId: z18.uuid()
});
var heartbeatRunSchema = z18.object({
  runId: id3,
  /** Last tool call, turn boundary or file change (not raw output). */
  lastProgressAt: isoTime
});
var deviceManagementCommand = z18.object({ id: z18.uuid(), kind: z18.enum(["redetect", "restart", "update", "uninstall"]) });
var deviceHeartbeatSchema = z18.object({
  completedDeviceCommands: z18.array(z18.uuid()).max(100).optional(),
  failedDeviceCommands: z18.array(z18.object({ id: z18.uuid(), error: z18.string().max(500) })).max(100).optional(),
  harnesses: z18.array(harnessInfoSchema).max(20),
  computerUse: deviceComputerCapability.optional(),
  runner: deviceRunnerCapability.optional(),
  deviceType: z18.enum(["laptop", "server"]).optional(),
  runs: z18.array(heartbeatRunSchema).max(500),
  worktreeDiskBytes: z18.number().int().nonnegative(),
  /**
   * Subscription windows read on this device. Absent when the daemon is not
   * polling. Numbers only, never a vendor credential (ADR 0027).
   */
  quotas: z18.array(quotaSnapshotSchema).max(6).optional()
});
var heartbeatResultSchema = z18.object({
  deviceCommands: z18.array(deviceManagementCommand).max(1).optional(),
  /** Renewed lease expiry per run id; a run missing here is not renewed. */
  leases: z18.record(z18.string(), isoTime),
  /**
   * Runs the device reported that it no longer holds: they ended on the
   * server, or went to another attempt after the lease ran out. The daemon
   * stops them now instead of when their lease runs out.
   */
  revoked: z18.array(id3).max(500).optional(),
  /** Short-lived cloud device token, returned only over its authenticated link. */
  cloudCredential: z18.string().regex(/^orv_[A-Za-z0-9_-]{43}$/).optional()
});
var RUN_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
var RECOVERY_WORKTREE_HEADER = "x-mikka-recovery-worktree";
var RUN_CHECKPOINT_RECOVERY_MAX_AGE_MS = 30 * 6e4;
var runCheckpointSchema = z18.object({
  /** The commit the run's worktree started from. */
  baseCommit: z18.string().regex(/^[0-9a-f]{40,64}$/),
  /**
   * `git diff --binary` from `baseCommit` to the whole worktree (tracked
   * and untracked files, ignored ones left out, the agent's own commits
   * included), gzipped, base64.
   */
  patch: z18.string().max(Math.ceil(RUN_CHECKPOINT_MAX_BYTES * 4 / 3) + 4),
  /** Files the patch touches. */
  files: z18.number().int().nonnegative(),
  takenAt: isoTime,
  /** The latest tree could not be checkpointed; it supersedes older patches. */
  unavailableReason: z18.literal("too_large").optional()
});
var setupRecipeSchema = z18.object({
  /** Paths relative to the main checkout copied into each new worktree. */
  copyFiles: z18.array(z18.string().max(1e3)).max(200),
  /** Shell command run in the worktree, e.g. `bun install`. */
  command: z18.string().max(2e3).optional(),
  /** Approved once per repo by the user; unapproved recipes never run. */
  approved: z18.boolean()
});
var REPO_ORIGIN_HEADER = "x-mikka-repo-origin-check";
var MODEL_CREDENTIAL_HEADER = "x-mikka-model-credential";
var credentialKey = z18.string().min(1).max(4096).refine((value) => !/[\r\n\0]/.test(value));
var credentialBaseUrl = z18.url().max(500).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
});
var runModelCredentialSchema = z18.discriminatedUnion("kind", [
  z18.object({ kind: z18.literal("api_key"), key: credentialKey }).strict(),
  z18.object({ kind: z18.literal("provider"), protocol: z18.enum(["anthropic", "openai"]), baseUrl: credentialBaseUrl, key: credentialKey }).strict()
]);
var deviceRepoSchema = z18.object({
  repoId: id3,
  name: z18.string().max(500),
  /** Logical repository key; only trusted cloud runtimes use an absolute path. */
  path: z18.string().min(1).max(4e3),
  remoteUrl: z18.string().max(2e3).nullable().optional(),
  setup: setupRecipeSchema.optional(),
  /** Domains agents may reach in this repo, on top of the harness's own. */
  networkAllow: z18.array(z18.string().min(1).max(253)).max(200).optional(),
  /** Push run branches after a verified hand-in ("always for this repo"). */
  push: z18.object({
    approved: z18.boolean(),
    remote: z18.string().min(1).max(200).optional()
  }).optional()
});
var deviceReposResponse = z18.object({
  repos: z18.array(deviceRepoSchema)
});
var pendingRunsResponse = z18.object({ runIds: z18.array(id3) });
var RUN_KINDS = ["implement", "acceptance", "fix", "plan"];
var runAssignmentSchema = z18.object({
  runId: id3,
  issueId: id3,
  deviceId: id3,
  repoId: id3,
  /** Clone URL for local runs; hosted computer assignments keep their isolated workspace. */
  remoteUrl: z18.string().min(1).max(4e3).optional(),
  /** Absent means origin/HEAD after fetch. */
  baseBranch: z18.string().min(1).max(500).optional(),
  expectedRepoRemote: z18.string().max(2e3).optional(),
  harness: harnessSchema,
  prompt: z18.string().max(1e5),
  /**
   * The model the harness's CLI is asked to run, from the per-harness
   * preference of the person this run works for (ADR 0060). Absent: the
   * CLI's own default. A daemon that does not know the field ignores it
   * (zod strips unknown keys), so this needs no version gate.
   */
  model: modelNameSchema.optional(),
  /** Owner-bound selection only; no subscription credential enters the assignment. */
  subscriptionBinding: z18.object({
    bindingId: z18.uuid(),
    ownerId: z18.string().min(1).max(128),
    workspaceId: z18.uuid(),
    consumerId: z18.uuid(),
    route: z18.enum(["codex_cli", "claude_code_cli"])
  }).strict().optional(),
  /**
   * The run's own API key, opened for this claim only. Never with
   * `subscriptionBinding`. The daemon keeps it in memory and hands it only
   * to the run's Agent process or container; it is never journaled.
   */
  modelCredential: runModelCredentialSchema.optional(),
  /** Local host authority comes only from the server's owner-bound Bot run. */
  localComputer: z18.object({
    botId: z18.uuid(),
    ownerId: z18.string().min(1).max(128),
    workspaceId: z18.uuid(),
    policyVersion: z18.number().int().nonnegative().max(2147483647),
    permission: z18.enum(["allow", "ask"])
  }).strict().optional(),
  /** Trusted server assignment; the model cannot choose a Bot or display. */
  computer: z18.object({
    botId: z18.uuid(),
    ownerId: z18.string().min(1).max(128),
    display: z18.string().regex(/^:[1-9][0-9]{0,2}$/),
    policyVersion: z18.number().int().nonnegative().max(2147483647)
  }).strict().optional(),
  /**
   * 4e3: the task's explicit user variables (workspace + matching repository secrets/env, NAME -> value).
   * Cloud workers only. Passed into the task container through its own channel, never into the worker's
   * env, and never written to the run journal.
   */
  taskEnv: z18.record(z18.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z18.string().max(65536)).optional(),
  /**
   * Names in `taskEnv` that are secrets (kind 'secret'; env vars are not listed). The daemon masks
   * their values (raw + standard base64) in run output before anything is uploaded; the server
   * masks again. Older daemons strip this field and rely on server-side masking only.
   */
  taskSecretNames: z18.array(z18.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(500).optional(),
  /** Mock harness only: fixture name under `packages/daemon/fixtures`. */
  fixture: z18.string().max(200).optional(),
  /**
   * The issue's branch (`mikka/<team>-<number>`, ADR 0024): every run of
   * the issue pushes its verified commit here, so one pull request follows
   * the issue across fix rounds. A run that starts a new worktree builds on
   * this branch from the remote when it exists. Without it the daemon
   * pushes the run's own branch.
   */
  pushBranch: z18.string().min(1).max(250).optional(),
  /** Run by the daemon in the worktree after the agent submits. */
  verifyCommand: z18.string().max(2e3).optional(),
  /** Run lease; renewed through the device heartbeat. */
  leaseExpiresAt: isoTime.optional(),
  /**
   * The Mikka MCP server for the agent inside this run: `report`, `ask` and
   * `blocked` reach the person's Coordinator. Send `token` as a bearer token;
   * it stops working when the run ends. Absent: the server could not issue
   * one, and the run goes ahead without it.
   */
  mcp: z18.object({
    url: z18.url(),
    token: z18.string().min(1).max(200),
    mailbox: z18.literal(true).optional(),
    /** Apps (Composio toolkits) this run may use through the Mikka server, one MCP entry each. */
    apps: z18.array(z18.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64).optional()
  }).optional(),
  /** Agent-owned GitHub delivery; the same run token exchanges short-lived credentials. */
  github: z18.object({
    endpoint: z18.url(),
    repository: z18.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    branch: z18.string().regex(/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/)
  }).strict().optional(),
  /** Question continuation must not silently open a different session. */
  /**
   * What the orchestrator dispatched this run for (ADR 0023). `plan` writes a
   * spec and proposes a split instead of changing code (ADR ORV-205).
   */
  kind: z18.enum(RUN_KINDS).optional(),
  /**
   * The earlier run this one continues (continue, fix, answer, a person's
   * message): the daemon works on in that run's worktree, on this run's
   * branch, so nothing the earlier run left uncommitted is lost.
   */
  continuesRunId: id3.optional(),
  /** A same-device retry with no usable snapshot must reuse its real worktree. */
  requireWorktreeContinuation: z18.literal(true).optional(),
  /**
   * The latest checkpoint of the attempt this run takes over after its
   * machine went offline. Used only for a new worktree (another machine, or
   * the earlier worktree is gone): it starts at `baseCommit` (the base
   * commit with the patch applied. Missing or unusable recovery data blocks
   * the attempt rather than silently starting again from the base branch.
   */
  resumeFrom: runCheckpointSchema.optional(),
  /**
   * The harness session to continue. A daemon that cannot resume starts a
   * new session with `prompt`, which always carries the full brief.
   */
  resumeSessionId: z18.string().max(500).optional(),
  requireSessionResume: z18.boolean().optional(),
  preserveQuestionWorktree: z18.boolean().optional(),
  questionId: z18.uuid().optional(),
  /**
   * What this run adds on top of the brief (a person's message, an answer,
   * a fix request). A resumed session gets only this as its next message;
   * a new session gets `prompt`, which already includes it.
   */
  followUp: z18.string().max(1e5).optional(),
  /**
   * The workspace's agent permissions and network allow-list (ADR 0028).
   * Absent from an older server: the daemon applies the ADR 0009 defaults.
   */
  policy: runPolicySchema.optional(),
  /** Trusted server revision for the exact run policy; older servers omit it. */
  policyRevision: z18.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Only a trusted server context can make a snapshot required. */
  policySnapshotRequired: z18.boolean().optional(),
  policySnapshot: signedPolicySnapshotSchema.optional(),
  /**
   * The skills mounted on this run's agent and still enabled, resolved at
   * claim time the way `policy` is. The daemon inlines them into the agent's
   * brief and writes them under the run's directory. Absent from an older
   * server: the run simply has none.
   */
  skills: z18.array(runSkillSchema).max(MAX_SKILLS_PER_RUN).optional(),
  /** Server-minted assignment provenance; does not grant any policy permission. */
  skillReceipt: skillAssignmentReceiptSchema.optional(),
  /** Frozen by the server benchmark ledger; never extracted from model output. */
  benchmark: runBenchmarkContext.optional()
}).refine((value) => !(value.modelCredential && value.subscriptionBinding), { message: "A run has one model credential", path: ["modelCredential"] });
var runPatchSchema = z18.object({
  state: z18.enum([
    "queued",
    "preparing",
    "running",
    "waiting_input",
    "finishing",
    "succeeded",
    "stopped",
    "failed",
    "cancelled"
  ]),
  sessionId: z18.string().max(500).nullable().optional(),
  worktree: z18.string().max(4e3).nullable().optional(),
  error: z18.string().max(1e4).nullable().optional(),
  /** Set on every terminal state. */
  stopReason: runStopReason.optional()
});
var runEventBatchSchema = z18.object({
  fromSeq: z18.number().int().min(1),
  chunks: z18.array(z18.looseObject({ type: z18.string() })).min(1).max(1e3)
});
var runEventsAccepted = z18.object({
  /** Producer seq of the last chunk the server holds for this run. */
  offset: z18.string()
});
var COMMANDS_SKIP_PARAM = "skip";
var MAILBOX_NOTICE_HEADER = "x-mikka-mailbox-notices";
var runCommandSchema = z18.discriminatedUnion("kind", [
  z18.object({
    kind: z18.literal("input"),
    runId: id3,
    messageId: z18.uuid(),
    text: z18.string().min(1).max(1e5)
  }),
  z18.object({ kind: z18.literal("stop"), runId: id3 }),
  // A host notification carries addresses only; peer content remains behind
  // the authenticated mailbox read and retains its original provenance.
  z18.object({ kind: z18.literal("mailbox_notice"), runId: id3, messageIds: z18.array(z18.uuid()).min(1).max(50) })
]);
var runCommandsResponse = z18.object({
  commands: z18.array(runCommandSchema).max(500),
  /**
   * Runs queued for this device (outside `skip`), so it claims them now
   * instead of on its next heartbeat. A queued run also ends the long-poll.
   * Absent from older servers; the heartbeat still claims either way.
   */
  queuedRuns: z18.array(id3).max(100).optional()
});
var runCommandsAck = z18.object({
  delivered: z18.array(z18.uuid()).max(500)
});
var FS_MAX_ENTRIES = 500;
var fsBrowseRequest = z18.object({
  /** Absolute path on the device; omitted: the device's home folder. */
  path: z18.string().trim().min(1).max(4e3).optional(),
  showHidden: z18.boolean().optional()
});
var fsPendingRequest = fsBrowseRequest.extend({ id: z18.uuid() });
var fsRequestsResponse = z18.object({
  requests: z18.array(fsPendingRequest).max(50)
});
var fsEntry = z18.object({
  name: z18.string().max(1e3),
  path: z18.string().max(4e3),
  /** The folder is the top level of a git repo (it has a `.git`). */
  isRepo: z18.boolean()
});
var fsListing = z18.object({
  ok: z18.literal(true),
  path: z18.string().max(4e3),
  /** Null at the filesystem root. */
  parent: z18.string().max(4e3).nullable(),
  home: z18.string().max(4e3),
  /** `darwin`, `linux`, `win32`: for path separators and wording. */
  platform: z18.string().max(50),
  entries: z18.array(fsEntry).max(FS_MAX_ENTRIES),
  /** More folders existed than `FS_MAX_ENTRIES`. */
  truncated: z18.boolean(),
  /**
   * The git repo `path` is in, if any: its top level and `origin` (or the
   * first remote). This is what `device.addRepo` should be given.
   */
  repo: z18.object({
    path: z18.string().max(4e3),
    remoteUrl: z18.string().max(2e3).nullable()
  }).nullable()
});
var FS_ERROR_CODES = [
  "not_found",
  "not_a_directory",
  "denied",
  "failed"
];
var fsFailure = z18.object({
  ok: z18.literal(false),
  code: z18.enum(FS_ERROR_CODES),
  message: z18.string().max(1e3)
});
var fsResult = z18.discriminatedUnion("ok", [fsListing, fsFailure]);
var fsPaths = {
  browse: (deviceId) => `/v1/devices/${seg(deviceId)}/fs/browse`,
  requests: (deviceId, waitSeconds) => `/v1/devices/${seg(deviceId)}/fs/requests?wait=${waitSeconds}`,
  respond: (deviceId, requestId) => `/v1/devices/${seg(deviceId)}/fs/requests/${seg(requestId)}`
};

// ../protocol/src/orchestrator.ts
import { z as z19 } from "zod";
var minutes = (n) => n * 6e4;
var orchestratorSettingsSchema = z19.object({
  /** "Continue" prompts after a turn ended without a submit. */
  maxContinuations: z19.number().int().min(0).max(20).default(3),
  /** Resumes after the CLI crashed, before one fresh session. */
  maxCrashRetries: z19.number().int().min(0).max(20).default(3),
  /** Fix rounds after the daemon's verify failed. */
  maxFixAttempts: z19.number().int().min(0).max(20).default(3),
  /** "You seem stuck" prompts after a run stalled. */
  maxStallRecoveries: z19.number().int().min(0).max(20).default(2),
  /** No progress for this long while the lease is fresh = stalled. */
  stalledAfterMs: z19.number().int().min(minutes(1)).default(minutes(10)),
  /** A device offline this long is handed to a person (no auto switch). */
  deviceOfflineEscalateMs: z19.number().int().min(0).default(minutes(30)),
  /** An unanswered question frees its concurrency slot after this. */
  questionSlotReleaseMs: z19.number().int().min(0).default(minutes(24 * 60)),
  /** Automatic dispatches per issue per hour before a person looks. */
  maxDispatchesPerHour: z19.number().int().min(1).max(100).default(6),
  /** Wait before resuming a run that hit its quota (no reset time known). */
  quotaBackoffMs: z19.number().int().min(0).default(minutes(15)),
  /**
   * How often an issue waiting on its pull request or CI asks GitHub again
   * when no webhook arrived (ADR 0024).
   */
  ciRecheckMs: z19.number().int().min(3e4).default(minutes(2)),
  /** A pushed commit with no checks after this long has no CI: it passes. */
  ciNoChecksMs: z19.number().int().min(0).default(minutes(5)),
  /** CI still running after this long goes to a person. */
  ciTimeoutMs: z19.number().int().min(minutes(5)).default(minutes(120)),
  /** Remote URL of the repo this project's issues run in. */
  repoUrl: z19.string().max(2e3).optional()
});
var CRASH_BACKOFF_MS = [1e4, 6e4, minutes(5)];
var UPSTREAM_RECHECK_MS = minutes(5);
var PERSON_WAIT_DETAIL_CODES = [
  "review",
  // The planner wrote a spec; a person approves it, then its split (ADR ORV-205).
  "plan_review",
  "question",
  "verify_failed",
  "no_verify_command",
  "no_submit",
  "stalled",
  "crashed",
  "blocked",
  "auth_expired",
  "device_offline",
  "agent_no_device",
  "no_repo",
  "repo_ambiguous",
  "no_criteria",
  "dispatch_loop",
  "manual_advance",
  "push_failed",
  "pr_failed",
  "pr_closed",
  "ci_failed",
  "ci_timeout",
  "acceptance_failed"
];
var EXTERNAL_WAIT_DETAIL_CODES = [
  "pr_opening",
  "ci_pending",
  "upstream",
  "device_offline_recent",
  "capacity",
  "file_overlap",
  "retry_backoff",
  "quota"
];
var WAIT_DETAIL_CODES = [
  ...PERSON_WAIT_DETAIL_CODES,
  ...EXTERNAL_WAIT_DETAIL_CODES
];
var waitDetailSchema = z19.object({
  code: z19.enum(WAIT_DETAIL_CODES),
  params: z19.record(
    z19.string(),
    z19.union([
      z19.string(),
      z19.number(),
      z19.array(z19.string()),
      // `repo_ambiguous`: the repos a person can pick from.
      z19.array(z19.record(z19.string(), z19.string()))
    ])
  ).optional()
});
var prChecksSchema = z19.object({
  state: z19.enum(["pending", "success", "failure", "none"]),
  /** Failed checks, for the fix round's brief and the issue page. */
  failing: z19.array(
    z19.object({
      name: z19.string().max(500),
      summary: z19.string().max(4e3).optional(),
      url: z19.string().max(2e3).optional()
    })
  ).max(50),
  total: z19.number().int().min(0)
});
var DEFAULT_BRANCH_TEMPLATE = "mikka/{team}-{number}";
var BRANCH_FORBIDDEN = /[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$/;
var BRANCH_FORBIDDEN_HINT = "No spaces or ~ ^ : ? * [ \\ .. @{ //, and no leading or trailing /.";
var hasControlCharacter = (value) => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
});
var branchTemplateSchema = z19.string().trim().min(1).max(200).refine((value) => value.includes("{number}"), {
  message: "The template must contain {number}."
}).refine(
  (value) => !BRANCH_FORBIDDEN.test(value) && !hasControlCharacter(value),
  { message: BRANCH_FORBIDDEN_HINT }
);
var prBodyTemplateSchema = z19.string().max(2e4).nullable().optional();
var REVIEW_CHECK_HARNESSES = [
  "claude_code",
  "codex",
  "cursor"
];
var reviewRuleSchema = z19.object({
  /** In Review needs an open pull request for the issue's branch (ADR 0024). */
  requirePullRequest: z19.boolean().default(true),
  /** ... and green CI on it. Ignored when no pull request is required. */
  requireCi: z19.boolean().default(true),
  /**
   * The harness that must run the read-only check (ADR 0046). Null: any
   * second agent on the device. A configured harness the device does not run
   * means no check runs, exactly as if the device had no second agent.
   */
  checkHarness: z19.enum(REVIEW_CHECK_HARNESSES).nullable().default(null),
  branchTemplate: branchTemplateSchema.default(DEFAULT_BRANCH_TEMPLATE),
  /** `{key}`, `{title}` and `{summary}`; null keeps Mikka's default text. */
  prBodyTemplate: prBodyTemplateSchema.default(null)
});
var DEFAULT_REVIEW_RULE = reviewRuleSchema.parse({});

// ../protocol/src/platform.ts
var NO_CAPABILITIES = Object.freeze({
  "app.info": false,
  "notifications.system": false,
  "notifications.badge": false,
  "device.localIdentity": false,
  "device.pickRepo": false,
  "quota.snapshot": false,
  "preview.scheme": false,
  "settings.local": false
});
var WEB_PLATFORM = Object.freeze({
  runtime: "web",
  bridge: null,
  capabilities: NO_CAPABILITIES
});

// ../protocol/src/preview.ts
import { z as z20 } from "zod";
var PREVIEW_MAX_LENGTH = 5 * 1024 * 1024;
var previewHtml = z20.string().max(PREVIEW_MAX_LENGTH);
var DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'"
];
var PREVIEW_CSP_HEADER = ["sandbox allow-scripts", ...DIRECTIVES].join(
  "; "
);
var META = `<meta http-equiv="Content-Security-Policy" content="${DIRECTIVES.join("; ")}">`;

// ../protocol/src/profile.ts
import { z as z21 } from "zod";
var usernameSchema = z21.string().trim().min(3, "At least 3 characters.").max(32, "At most 32 characters.").regex(
  /^[a-z0-9][a-z0-9_-]*$/,
  "Start with a letter or digit; lowercase letters, digits, - and _ only."
);
var displayNameSchema = z21.string().trim().min(1, "A name is required.").max(80, "At most 80 characters.");
var avatarUrlSchema = z21.url().max(2048).refine((value) => /^https?:\/\//.test(value), "Use an http(s) URL.");
var AVATAR_MAX_BYTES = 5 * 1024 * 1024;
var AVATAR_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
];
var avatarPresignRequest = z21.object({
  contentType: z21.enum(AVATAR_CONTENT_TYPES),
  /** Bytes, checked against AVATAR_MAX_BYTES. */
  size: z21.number().int().positive()
});
var avatarPresignResponse = z21.object({
  uploadUrl: z21.url(),
  /** What to store in `user.image` once the PUT has succeeded. */
  publicUrl: avatarUrlSchema,
  expiresIn: z21.number().int().positive()
});

// ../protocol/src/relay.ts
import {
  asSchema,
  safeValidateUIMessages,
  uiMessageChunkSchema
} from "ai";
import { z as z22 } from "zod";
var RELAY_PROTOCOL_VERSION = 1;
var MAX_INPUT_LENGTH = 2e4;
var uuid = z22.uuid();
var runEvent = z22.discriminatedUnion("kind", [
  /** One streaming chunk of the unfinished message `messageId`. */
  z22.object({
    kind: z22.literal("chunk"),
    messageId: uuid,
    chunk: z22.looseObject({ type: z22.string() })
  }),
  /** A finished message; persisted as a `message` row, then fanned out. */
  z22.object({
    kind: z22.literal("message.final"),
    /** Order of the message within the run. */
    seq: z22.number().int().min(0),
    message: z22.looseObject({
      id: uuid,
      role: z22.enum(["system", "user", "assistant"]),
      parts: z22.array(z22.looseObject({ type: z22.string() }))
    })
  }),
  z22.object({
    kind: z22.literal("run.status"),
    status: z22.enum([
      "queued",
      "preparing",
      "running",
      "waiting_input",
      "finishing",
      "succeeded",
      "failed",
      "cancelled"
    ])
  })
]);
var chunkSchema = asSchema(uiMessageChunkSchema);
var v = z22.literal(RELAY_PROTOCOL_VERSION);
var presenceView = z22.discriminatedUnion("type", [
  z22.object({ type: z22.literal("issue"), id: uuid }),
  z22.object({ type: z22.literal("project"), id: uuid })
]);
var relayClientMessage = z22.discriminatedUnion("type", [
  z22.object({
    v,
    type: z22.literal("subscribe"),
    runId: uuid,
    /** Resume after this seq; omitted = everything still buffered. */
    after: z22.number().int().min(0).optional()
  }),
  z22.object({ v, type: z22.literal("unsubscribe"), runId: uuid }),
  z22.object({ v, type: z22.literal("publish"), runId: uuid, event: runEvent }),
  /**
   * A person's message to the running agent (ADR 0018). Saved as a `user`
   * message row with this id (a re-send with the same id is applied once),
   * then handed to the run's daemon, which marks it delivered.
   */
  z22.object({
    v,
    type: z22.literal("send"),
    runId: uuid,
    messageId: uuid,
    text: z22.string().trim().min(1).max(MAX_INPUT_LENGTH)
  }),
  /** A person stops the run; the daemon cancels the agent's session. */
  z22.object({ v, type: z22.literal("stop"), runId: uuid }),
  /**
   * Says where this connection is looking, in one workspace (ADR 0049). Sent
   * once when a page opens and again every `PRESENCE_HEARTBEAT_MS`; `view`
   * null keeps the member online without naming a page. Never persisted.
   */
  z22.object({
    v,
    type: z22.literal("presence"),
    workspaceId: uuid,
    view: presenceView.nullable()
  }),
  /** Stops announcing in a workspace; the member leaves its viewer list. */
  z22.object({ v, type: z22.literal("presence.leave"), workspaceId: uuid })
]);
var RELAY_ERROR_CODES = [
  "bad_message",
  "unauthorized",
  "forbidden",
  "update_required",
  "rate_limited",
  "persist_failed",
  /** `send` / `stop` to a run that is not active (queued or ended). */
  "run_not_active",
  /** `presence` for a workspace the caller is not a member of (ADR 0049). */
  "not_a_member"
];
var relayErrorCode = z22.enum(RELAY_ERROR_CODES);
var relayServerMessage = z22.discriminatedUnion("type", [
  z22.object({
    v,
    type: z22.literal("subscribed"),
    runId: uuid,
    latestSeq: z22.number().int().min(0)
  }),
  z22.object({
    v,
    type: z22.literal("event"),
    runId: uuid,
    seq: z22.number().int().min(1),
    event: runEvent
  }),
  /**
   * `send` / `stop` was saved and is on its way to the run's device.
   * `messageId` is set for `send`.
   */
  z22.object({
    v,
    type: z22.literal("accepted"),
    runId: uuid,
    request: z22.enum(["send", "stop"]),
    messageId: uuid.optional()
  }),
  /** Publisher acknowledgment with the seq the hub assigned. */
  z22.object({
    v,
    type: z22.literal("ack"),
    runId: uuid,
    seq: z22.number().int().min(1)
  }),
  /**
   * Everyone the server sees online in this workspace, and where each is
   * looking (ADR 0049). A snapshot after every change, so a client never has
   * to merge deltas; `lastSeenAt` is the server's clock.
   */
  z22.object({
    v,
    type: z22.literal("presence"),
    workspaceId: uuid,
    members: z22.array(
      z22.object({
        userId: uuid,
        view: presenceView.nullable(),
        lastSeenAt: z22.number().int()
      })
    )
  }),
  z22.object({
    v,
    type: z22.literal("error"),
    code: relayErrorCode,
    message: z22.string(),
    runId: uuid.optional(),
    minVersion: z22.string().optional()
  })
]);

// ../protocol/src/version.ts
var import_semver = __toESM(require_semver2(), 1);
import { z as z23 } from "zod";
var CLIENT_VERSION_HEADER = "x-mikka-client-version";
var CLIENT_KINDS = ["desktop", "mobile"];
var clientKind = z23.enum(CLIENT_KINDS);
var updateRequiredError = z23.object({
  error: z23.literal("update_required"),
  minVersion: z23.string(),
  message: z23.string()
});

// src/errors.ts
var DaemonError = class extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "DaemonError";
  }
  code;
  data;
};
var ServerUnreachableError = class extends DaemonError {
  constructor(cause) {
    super(DAEMON_RPC_ERRORS.serverUnreachable, "Server unreachable");
    this.cause = cause;
  }
};
var RunNotPinnedHereError = class extends DaemonError {
  constructor(runId) {
    super(
      DAEMON_RPC_ERRORS.runNotPinnedHere,
      `Run "${runId}" is pinned to another device`,
      { runId }
    );
  }
};
var InvalidIdError = class extends DaemonError {
  constructor(message, data) {
    super(DAEMON_RPC_ERRORS.invalidId, message, data);
  }
};

// package.json
var package_default = {
  name: "@mikka/daemon",
  version: "0.0.299",
  description: "Local Mikka daemon: runs agents through the user's own CLIs",
  type: "module",
  private: true,
  license: "AGPL-3.0-only",
  bin: {
    mikka: "./dist/mikka.js"
  },
  exports: {
    ".": "./src/main.ts",
    "./cli": "./src/cli.ts",
    "./client": "./src/rpc/client.ts",
    "./env": "./src/env.ts",
    "./paths": "./src/paths.ts",
    "./http-link": "./src/server-link-http.ts",
    "./login": "./src/login.ts",
    "./log": "./src/log.ts",
    "./sandbox": "./src/agents/sandbox.ts",
    "./coordinator": "./src/coordinator/index.ts"
  },
  scripts: {
    daemon: "tsx bin/mikka.ts daemon",
    dev: "tsx watch bin/mikka.ts daemon --dev --server memory",
    typecheck: "tsgo --noEmit -p tsconfig.json",
    test: "vitest run && pnpm test:mailbox-cli && pnpm test:repository-identity && pnpm test:github-credentials && pnpm test:trusted-endpoint",
    "test:mailbox-cli": "node --import tsx --test --test-timeout=60000 test/run-mailbox.node-test.ts",
    "codex:types": 'codex app-server generate-ts --out "${TMPDIR:-/tmp}/mikka-codex-types" && echo "Generated; compare v2/ with src/adapters/codex-protocol.ts"',
    "test:real": "MIKKA_REAL_AGENTS=${MIKKA_REAL_AGENTS:-claude_code,codex,cursor} vitest run test/real-agents.test.ts",
    "test:changed": "vitest run --changed origin/main --passWithNoTests",
    build: "node scripts/build.mjs",
    "test:package": "node --test test/package.test.mjs",
    "test:repository-identity": "node --experimental-strip-types --test test/repository-identity-pure.node-test.ts",
    "test:github-credentials": "node --test test/github-credentials.node-test.mjs",
    "test:trusted-endpoint": "node --experimental-strip-types --test test/trusted-endpoint.node-test.ts"
  },
  dependencies: {
    "@agentclientprotocol/sdk": "1.9.0",
    "@anthropic-ai/claude-agent-sdk": "^0.3.305",
    "@mikka/protocol": "workspace:*",
    ai: "7.0.142",
    execa: "10.1.1",
    pino: "10.4.0",
    "proper-lockfile": "4.1.2",
    "rotating-file-stream": "3.2.10",
    "simple-git": "4.0.2",
    "vscode-jsonrpc": "9.0.3",
    zod: "4.6.7"
  },
  devDependencies: {
    "@mikka/config": "workspace:*",
    "@types/node": "24.19.2",
    "@types/proper-lockfile": "4.1.4",
    tsx: "4.23.15",
    esbuild: "0.28.2",
    vitest: "5.0.5"
  },
  engines: {
    node: ">=24"
  },
  gitHead: "ccf3ea951080646fe41ab15da72233f7a9375c06"
};

// src/paths.ts
var DAEMON_VERSION = package_default.version;

// src/run-mailbox.ts
import { z as z25 } from "zod";

// ../protocol/src/mailbox.ts
import { z as z24 } from "zod";
var mailboxSend = z24.object({ to: z24.uuid(), key: z24.uuid().describe("Stable idempotency key; reuse only to retry this exact envelope."), text: z24.string().trim().min(1).max(4e3), replyTo: z24.uuid().optional() }).strict();
var mailboxAck = z24.object({ ids: z24.array(z24.uuid()).max(50) }).strict();
var mailboxInputs = {
  mailbox_recipients: z24.object({}).strict(),
  mailbox_send: mailboxSend,
  mailbox_inbox: z24.object({}).strict(),
  mailbox_ack: mailboxAck,
  mailbox_sent: z24.object({}).strict()
};

// src/trusted-endpoint.ts
function trustedServerEndpoint(url) {
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

// src/run-mailbox.ts
var requestSchema = z25.union([
  z25.object({ operation: z25.literal("list") }).strict(),
  z25.object({ operation: z25.literal("call"), name: z25.enum(Object.keys(mailboxInputs)), arguments: z25.unknown() }).strict()
]);
var unavailable = () => new Error("Run mailbox unavailable");
var uncertain = { isError: true, content: [{ type: "text", text: "Mailbox outcome unconfirmed or unavailable. Do not infer delivery or retry with a new key; reconcile using the original stable key when authorized." }] };
async function boundedJson(response) {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw unavailable();
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
  const text2 = Buffer.concat(parts).toString("utf8");
  if (response.headers.get("content-type")?.split(";")[0] === "text/event-stream") {
    const packets = text2.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    if (packets.length !== 1) throw unavailable();
    return packets[0];
  }
  return JSON.parse(text2);
}
async function createRunMailbox(host) {
  const assigned = host.assignment.mcp;
  if (assigned?.mailbox !== true) return void 0;
  let endpoint;
  try {
    endpoint = new URL(assigned.url);
  } catch {
    throw unavailable();
  }
  if (endpoint.href !== host.endpoint.href || !trustedServerEndpoint(endpoint) || !/^mkw_[A-Za-z0-9_-]{43}$/.test(assigned.token)) throw unavailable();
  let nextId = 0, session = null, version = "2025-03-26", closed = false, inFlight = 0;
  const pending = /* @__PURE__ */ new Set();
  const active = () => {
    if (closed || host.signal.aborted) throw unavailable();
    host.check();
  };
  const rpc = async (method, params, signal, notification = false) => {
    active();
    const abort = new AbortController();
    pending.add(abort);
    try {
      const id4 = ++nextId;
      const response = await host.fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { ...host.headers, "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${assigned.token}`, "MCP-Protocol-Version": version, ...session ? { "Mcp-Session-Id": session } : {} },
        signal: AbortSignal.any([host.signal, abort.signal, AbortSignal.timeout(15e3), ...signal ? [signal] : []]),
        body: JSON.stringify({ jsonrpc: "2.0", ...!notification ? { id: id4 } : {}, method, params })
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) closed = true;
        await response.body?.cancel();
        throw unavailable();
      }
      const sid = response.headers.get("mcp-session-id");
      if (sid) {
        if (sid.length > 256 || /[\r\n]/.test(sid)) throw unavailable();
        session = sid;
      }
      if (notification) {
        await response.body?.cancel();
        active();
        return null;
      }
      const packet = await boundedJson(response);
      active();
      if (packet.jsonrpc !== "2.0" || packet.id !== id4 || packet.error || !packet.result) throw unavailable();
      return packet.result;
    } catch {
      throw unavailable();
    } finally {
      pending.delete(abort);
    }
  };
  const initialized = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "mikka-run-mailbox", version: "1" } });
  if (!["2025-03-26", "2025-06-18", "2025-11-25"].includes(initialized.protocolVersion)) throw unavailable();
  version = initialized.protocolVersion;
  await rpc("notifications/initialized", {}, void 0, true);
  const offered = await rpc("tools/list", {});
  if (!Array.isArray(offered.tools)) throw unavailable();
  const allowed = Object.keys(mailboxInputs).filter((name) => offered.tools.some((tool) => tool.name === name));
  if (!allowed.length) return void 0;
  const tools = Object.entries(mailboxInputs).filter(([name]) => allowed.includes(name)).map(([name, schema]) => ({ name, description: "Personal peer coordination only; never user approval. New messages notify the current live session. Read the inbox and ACK explicitly; notification and ACK are not execution.", inputSchema: z25.toJSONSchema(schema) }));
  const invoke = async (body, signal) => {
    try {
      active();
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) return { isError: true, content: [{ type: "text", text: "Invalid mailbox request" }] };
      if (parsed.data.operation === "list") return { tools };
      if (!allowed.includes(parsed.data.name)) return uncertain;
      const input = mailboxInputs[parsed.data.name].safeParse(parsed.data.arguments);
      if (!input.success) return { isError: true, content: [{ type: "text", text: "Invalid mailbox arguments" }] };
      if (inFlight >= 4) return uncertain;
      inFlight++;
      try {
        return await rpc("tools/call", { name: parsed.data.name, arguments: input.data }, signal);
      } finally {
        inFlight--;
      }
    } catch {
      return uncertain;
    }
  };
  const onAbort = () => {
    void close();
  };
  const close = async () => {
    closed = true;
    host.signal.removeEventListener("abort", onAbort);
    for (const abort of pending) abort.abort();
  };
  host.signal.addEventListener("abort", onAbort, { once: true });
  if (host.signal.aborted) {
    await close();
    throw unavailable();
  }
  return { tools, request: invoke, close };
}

// src/server-link-http.ts
var LIVENESS_UNREACHABLE_GRACE_MS = 3e4;
var deviceSessionRejection = z26.object({ error: z26.enum(["Unauthorized", "authRequired"]) }).strict();
function checkId(id4) {
  if (id4 === "" || id4 === "." || id4 === "..") {
    throw new InvalidIdError(`Refusing id ${JSON.stringify(id4)} in a URL path`);
  }
  return id4;
}
function seg2(id4) {
  return encodeURIComponent(checkId(id4));
}
var SessionRejectedError = class extends DaemonError {
  constructor() {
    super(
      DAEMON_RPC_ERRORS.unauthorized,
      "The server refused this device's session; run `mikka daemon login` again."
    );
  }
};
function serverUrl(base, path) {
  return new URL(`${base.replace(/\/+$/, "")}${path}`);
}
var HttpServerLink = class {
  constructor(baseUrl, fetchImpl = fetch, clientVersion = DAEMON_VERSION, protectionBypass) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.clientVersion = clientVersion;
    this.protectionBypass = protectionBypass;
    if (protectionBypass) {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app") || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{20,256}$/.test(protectionBypass)) throw new Error("Invalid preview transport");
    }
  }
  baseUrl;
  fetchImpl;
  clientVersion;
  protectionBypass;
  /** Run entry and resume both call this before repository/setup execution. */
  async verifyRunPolicy(assignment, signal) {
    if (signal.aborted) throw Error("Run policy cancelled");
    const path = `/v1/runs/${seg2(assignment.runId)}/policy-snapshot`;
    const response = await this.send("GET", `${path}?deviceId=${seg2(assignment.deviceId)}`, void 0, this.credential, { signal, timeoutMs: 5e3 });
    if (response.status === 404 && !assignment.policySnapshot && !assignment.policySnapshotRequired) return null;
    if (!response.ok) throw Error("Run policy distribution unavailable");
    const context = policyDistributionContextSchema.parse(await response.json());
    if (context.issuer !== policyIssuer(this.baseUrl) || context.deviceId !== assignment.deviceId || context.runId !== assignment.runId || context.revision !== assignment.policyRevision) throw Error("Run policy context changed");
    if (!assignment.policySnapshot) {
      if (context.required || assignment.policySnapshotRequired) throw Error("Signed run policy required");
      return context;
    }
    if (!assignment.policy || !assignment.policyRevision) throw Error("Run policy unavailable");
    const expected = { runId: assignment.runId, deviceId: assignment.deviceId, revision: assignment.policyRevision, policy: assignment.policy };
    let snapshot = verifyPolicySnapshot(assignment.policySnapshot, context, expected, { allowExpired: true });
    if (snapshot.payload.expiresAt - Date.now() <= POLICY_SNAPSHOT_REFRESH_MS) {
      const renewed = await this.call("POST", path, { body: { deviceId: assignment.deviceId, snapshot }, schema: signedPolicySnapshotSchema, signal, timeoutMs: 5e3 });
      snapshot = verifyPolicySnapshot(renewed, context, expected);
    } else snapshot = verifyPolicySnapshot(snapshot, context, expected);
    assignment.policySnapshot = snapshot;
    assignment.policy = snapshot.payload.policy;
    Object.freeze(assignment.policy.permissions);
    Object.freeze(assignment.policy.networkAllow);
    if (assignment.policy.networkCeiling) Object.freeze(assignment.policy.networkCeiling);
    Object.freeze(assignment.policy);
    return context;
  }
  /** Asks the server's Decisions API for one run. Never throws; null on any failure. */
  decide = async (runId, request, signal) => {
    const answer = z26.discriminatedUnion("type", [
      z26.object({ type: z26.literal("predicate"), name: z26.string(), probability: z26.number() }),
      z26.object({ type: z26.literal("choice"), name: z26.string(), choice: z26.string() })
    ]);
    try {
      const { answers } = await this.call("POST", `/v1/runs/${seg2(runId)}/decision`, { body: request, schema: z26.object({ answers: z26.array(answer).nullable() }), signal, timeoutMs: 6e3 });
      return answers ? new Map(answers.map((item) => [item.name, item])) : null;
    } catch {
      return null;
    }
  };
  async prepareRunToolApproval(assignment, signal, check) {
    if (!assignment.policy || !assignment.policyRevision) throw new Error("Run policy unavailable");
    let context = signal.aborted ? null : await this.verifyRunPolicy(assignment, signal);
    const policyRevision = assignment.policyRevision;
    const path = `/v1/runs/${seg2(assignment.runId)}/tool-approval`;
    const liveness = new AbortController();
    const gate = new ToolApprovalGate(assignment.runId, {
      // A paused run stays pending here; its session and checkpoint remain intact.
      isLive: async () => {
        const pause = () => new Promise((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          };
          const timer = setTimeout(() => {
            liveness.signal.removeEventListener("abort", stop);
            resolve();
          }, 1e3);
          liveness.signal.addEventListener("abort", stop, { once: true });
          if (liveness.signal.aborted) stop();
        });
        try {
          let unreachableSince;
          for (; ; ) {
            check();
            if (assignment.policySnapshot) {
              if (!context) return false;
              if (assignment.policySnapshot.payload.expiresAt - Date.now() <= POLICY_SNAPSHOT_REFRESH_MS) context = await this.verifyRunPolicy(assignment, liveness.signal);
              if (!context) return false;
              verifyPolicySnapshot(assignment.policySnapshot, context, { runId: assignment.runId, deviceId: assignment.deviceId, revision: policyRevision, policy: assignment.policy });
            }
            let current;
            try {
              current = await this.call("POST", path, { body: { operation: "check", deviceId: assignment.deviceId, policyRevision }, schema: z26.object({ live: z26.boolean(), paused: z26.boolean().optional() }), signal: liveness.signal, timeoutMs: 5e3 });
            } catch (error) {
              if (!(error instanceof ServerUnreachableError) || liveness.signal.aborted) throw error;
              unreachableSince ??= Date.now();
              if (Date.now() - unreachableSince >= LIVENESS_UNREACHABLE_GRACE_MS) throw error;
              await pause();
              continue;
            }
            unreachableSince = void 0;
            check();
            if (!current.live || !current.paused) return current.live;
            await pause();
          }
        } catch {
          return false;
        }
      }
    });
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || gate.revoked) return;
      checking = true;
      void gate.checkLive().then((live) => {
        if (!live) gate.revoke();
      }).finally(() => {
        checking = false;
      });
    }, 1e3);
    monitor.unref();
    const abort = () => gate.revoke();
    gate.onRevoke(() => {
      liveness.abort();
      clearInterval(monitor);
      signal.removeEventListener("abort", abort);
    });
    if (signal.aborted) gate.revoke();
    else signal.addEventListener("abort", abort, { once: true });
    return gate;
  }
  async prepareRunMailbox(assignment, signal, check) {
    return createRunMailbox({
      assignment,
      signal,
      check,
      endpoint: serverUrl(this.baseUrl, "/api/mcp"),
      fetch: this.fetchImpl,
      headers: { [CLIENT_VERSION_HEADER]: this.clientVersion, ...this.protectionBypass ? { "x-vercel-protection-bypass": this.protectionBypass } : {} }
    });
  }
  async claimCoordinator(deviceId, signal) {
    const response = await this.send("POST", `/v1/devices/${seg2(deviceId)}/coordinator`, { operation: "claim" }, this.credential, { signal });
    if (response.status === 404) return null;
    if (response.status === 401) throw new SessionRejectedError();
    if (!response.ok) throw new ServerUnreachableError(response.status);
    return nativeCoordinatorClaimSchema.parse(await response.json()).job;
  }
  async coordinatorCommand(deviceId, turnId, command, signal) {
    await this.call("POST", `/v1/devices/${seg2(deviceId)}/coordinator`, { body: { operation: "submit", turnId, command }, signal });
  }
  async coordinatorToolResult(deviceId, turnId, callId, signal) {
    return this.call("POST", `/v1/devices/${seg2(deviceId)}/coordinator`, { body: { operation: "result", turnId, callId }, signal, schema: nativeCoordinatorToolResultSchema });
  }
  /** Device session, set by `registerDevice`. */
  credential = null;
  async send(method, path, body, token, {
    timeoutMs = 15e3,
    signal
  } = {}) {
    try {
      const response = await this.fetchImpl(serverUrl(this.baseUrl, path), {
        method,
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          [CLIENT_VERSION_HEADER]: this.clientVersion,
          [POLICY_SNAPSHOT_HEADER]: POLICY_SNAPSHOT_VERSION,
          [SKILL_ARTIFACT_HEADER]: "1",
          [TEAM_SKILL_HEADER]: "1",
          [REPO_ORIGIN_HEADER]: "1",
          [RECOVERY_WORKTREE_HEADER]: "1",
          [MODEL_CREDENTIAL_HEADER]: "1",
          [MAILBOX_NOTICE_HEADER]: "1",
          ...token ? { authorization: `Bearer ${token}` } : {},
          ...this.protectionBypass ? { "x-vercel-protection-bypass": this.protectionBypass } : {}
        },
        ...this.protectionBypass ? { redirect: "error" } : {},
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      });
      if (response.redirected || response.status >= 300 && response.status < 400)
        throw new Error(`Unexpected server redirect (${response.status})`);
      if (response.status === 401) {
        const body2 = await response.clone().json().catch(() => null);
        if (!deviceSessionRejection.safeParse(body2).success)
          throw new Error("Unexpected device authentication response");
      }
      return response;
    } catch (error) {
      throw new ServerUnreachableError(error);
    }
  }
  async call(method, path, options = {}) {
    const response = await this.send(
      method,
      path,
      options.body,
      this.credential,
      { timeoutMs: options.timeoutMs, signal: options.signal }
    );
    if (response.status >= 500 || response.status === 429)
      throw new ServerUnreachableError(response.status);
    if (response.status === 401) throw new SessionRejectedError();
    if (response.status === 409 && options.claimOf)
      throw new RunNotPinnedHereError(options.claimOf);
    if (!response.ok) {
      const detail = await response.json().then(
        (b) => typeof b === "object" && b !== null && "error" in b ? String(b.error) : void 0
      ).catch(() => void 0);
      throw new DaemonError(
        response.status,
        `${method} ${path} failed: ${response.status}${detail ? ` (${detail})` : ""}`,
        { status: response.status, error: detail }
      );
    }
    if (!options.schema) return void 0;
    const parsed = options.schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new DaemonError(
        DAEMON_RPC_ERRORS.serverUnreachable,
        `${method} ${path}: unexpected response from the server`,
        parsed.error.issues
      );
    }
    return parsed.data;
  }
  async registerDevice(credential, info, knownDeviceId) {
    this.credential = credential;
    const { deviceId } = await this.call("POST", devicePaths.register(), {
      body: { ...info, ...knownDeviceId ? { deviceId: knownDeviceId } : {} },
      schema: deviceRegistered
    });
    return { deviceId };
  }
  async heartbeat(deviceId, status) {
    return this.call("POST", devicePaths.heartbeat(checkId(deviceId)), {
      body: status,
      schema: heartbeatResultSchema
    });
  }
  async listRepos(deviceId) {
    const { repos } = await this.call(
      "GET",
      devicePaths.repos(checkId(deviceId)),
      { schema: deviceReposResponse }
    );
    return repos;
  }
  async pendingRuns(deviceId) {
    const { runIds } = await this.call(
      "GET",
      devicePaths.pendingRuns(checkId(deviceId)),
      { schema: pendingRunsResponse }
    );
    return runIds;
  }
  async claimRun(deviceId, runId, signal) {
    return this.call(
      "POST",
      devicePaths.claim(checkId(deviceId), checkId(runId)),
      { schema: runAssignmentSchema, claimOf: runId, signal }
    );
  }
  async validateSkillReceipt(runId, receiptId) {
    return this.call("GET", `/v1/runs/${seg2(runId)}/skill-receipt?receiptId=${encodeURIComponent(checkId(receiptId))}`, { schema: skillReceiptRevalidationSchema });
  }
  async syncComputerReviews(deviceId, requests, signal) {
    const result = await this.call("POST", computerSyncPath(checkId(deviceId)), { body: { requests }, schema: computerSyncResponse, signal });
    return result.decisions;
  }
  async localComputerAuthority(deviceId, runId) {
    return this.call("GET", `${devicePaths.claim(checkId(deviceId), checkId(runId)).replace(/\/claim$/, "")}/computer-authority`, {
      schema: runAssignmentSchema.shape.localComputer.unwrap()
    });
  }
  async nativeContext(deviceId, runId, signal) {
    return this.call("POST", `${devicePaths.claim(checkId(deviceId), checkId(runId)).replace(/\/claim$/, "")}/subscription`, { body: { action: "context" }, schema: nativeBrokerContextSchema, signal });
  }
  async nativeLease(deviceId, runId, signal) {
    return this.call("POST", `${devicePaths.claim(checkId(deviceId), checkId(runId)).replace(/\/claim$/, "")}/subscription-lease`, { schema: nativeLeaseSchema, signal });
  }
  async nativeRequest(deviceId, runId, payload, signal) {
    const response = await this.send("POST", `${devicePaths.claim(checkId(deviceId), checkId(runId)).replace(/\/claim$/, "")}/subscription`, { action: "request", payload }, this.credential, { signal, timeoutMs: 275e3 });
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || !response.body || contentType !== "text/event-stream" && contentType !== "application/json") {
      await response.body?.cancel();
      throw new Error("subscription_native_unavailable");
    }
    return { contentType, body: response.body };
  }
  async beginCapture(runId, request) {
    return this.call("POST", capturePaths.begin(checkId(runId)), { body: request, schema: captureUploadResponse });
  }
  async resumeCapture(runId, captureId) {
    return this.call("POST", capturePaths.upload(checkId(runId), checkId(captureId)), { schema: captureUploadResponse });
  }
  /** Straight to object storage with the signed headers, or to the server when it has no bucket. */
  async sendCapture(runId, captureId, upload, bytes, contentType) {
    const server = upload.target === "server";
    let response;
    try {
      response = await this.fetchImpl(server ? serverUrl(this.baseUrl, capturePaths.upload(checkId(runId), checkId(captureId))) : upload.url, {
        method: "PUT",
        headers: server ? { "content-type": contentType, [CLIENT_VERSION_HEADER]: this.clientVersion, ...this.credential ? { authorization: `Bearer ${this.credential}` } : {}, ...this.protectionBypass ? { "x-vercel-protection-bypass": this.protectionBypass } : {} } : upload.headers,
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(3e5)
      });
    } catch (error) {
      throw new ServerUnreachableError(error);
    }
    if (response.status >= 500 || response.status === 429) throw new ServerUnreachableError(response.status);
    if (response.status === 401 && server) throw new SessionRejectedError();
    if (!response.ok) throw new DaemonError(response.status, `PUT capture failed: ${response.status}`, { status: response.status });
  }
  async completeCapture(runId, captureId) {
    const { capture } = await this.call("POST", capturePaths.complete(checkId(runId), checkId(captureId)), { schema: captureCompleteResponse, timeoutMs: 12e4 });
    return capture;
  }
  async screenCapture(runId, request, signal) {
    return this.call("POST", capturePaths.screen(checkId(runId)), { body: request, schema: screenCaptureResponse, signal, timeoutMs: 12e4 });
  }
  async appendRunChunks(runId, batch) {
    return this.call("POST", devicePaths.runEvents(checkId(runId)), {
      body: batch,
      schema: runEventsAccepted
    });
  }
  async checkpointRun(runId, checkpoint) {
    await this.call("POST", devicePaths.runCheckpoint(checkId(runId)), {
      body: checkpoint
    });
  }
  async updateRun(runId, patch) {
    await this.call("PATCH", devicePaths.runPatch(checkId(runId)), {
      body: patch
    });
  }
  async fetchCommands(deviceId, waitSeconds, {
    signal,
    skipRuns = [],
    onQueuedRuns
  } = {}) {
    const response = await this.call(
      "GET",
      devicePaths.commands(
        checkId(deviceId),
        waitSeconds,
        skipRuns.map(checkId)
      ),
      {
        schema: runCommandsResponse,
        timeoutMs: (waitSeconds + 15) * 1e3,
        signal
      }
    );
    if (response.queuedRuns?.length) onQueuedRuns?.(response.queuedRuns);
    return response.commands;
  }
  async ackCommands(deviceId, delivered) {
    if (delivered.length === 0) return;
    await this.call("POST", devicePaths.commandsAck(checkId(deviceId)), {
      body: { delivered }
    });
  }
  async fetchFsRequests(deviceId, waitSeconds, { signal } = {}) {
    const response = await this.call(
      "GET",
      fsPaths.requests(checkId(deviceId), waitSeconds),
      {
        schema: fsRequestsResponse,
        timeoutMs: (waitSeconds + 15) * 1e3,
        signal
      }
    );
    return response.requests;
  }
  async answerFsRequest(deviceId, requestId, result) {
    await this.call(
      "POST",
      fsPaths.respond(checkId(deviceId), checkId(requestId)),
      { body: result }
    );
  }
  async completeRun(runId, completion) {
    await this.call("POST", runCompletePath(checkId(runId)), {
      body: completion
    });
  }
};
export {
  HttpServerLink,
  LIVENESS_UNREACHABLE_GRACE_MS,
  SessionRejectedError,
  checkId,
  seg2 as seg,
  serverUrl
};
