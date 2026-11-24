/**
 * Minimal regex→string generator for `@ktb/seed`.
 *
 * The `@ktb/json-schema` subset accepts any JS-regex `pattern`, but only
 * a safe, common subset is generatable: literals, `.`, escapes
 * (`\d \w \s` and friends), character classes (incl. ranges and
 * negation), groups `(...)` / `(?:...)`, alternation `|`, anchors
 * `^`/`$` (ignored — they are zero-width) and quantifiers
 * `* + ? {n} {n,} {n,m}` (lazy `?` suffix accepted and ignored).
 *
 * Anything else — lookarounds, backreferences, named groups, inline
 * flags, `\x`-less exotic escapes we don't model — throws
 * {@link SeedError} so callers fail loudly instead of emitting
 * non-conforming data. Generated candidates are still verified against
 * the real `RegExp` by the caller before being returned.
 */
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { SeedError } from "./errors.ts";

/** Hard cap on generated pattern output — guards `(a+)+`-style
 * blowups the subset checker already rejects, plus `{10000}` quantifiers. */
const MAX_PATTERN_OUTPUT = 1024;
/** Per-quantifier expansion cap. */
const MAX_REPEAT = 64;
/** Default upper bound for unbounded quantifiers. */
const UNBOUNDED_MAX = 8;
/** Code-point window used to expand negated classes: printable ASCII. */
const PRINTABLE_LO = 0x20;
const PRINTABLE_HI = 0x7e;
type Range = readonly [number, number];
type Atom = {
  readonly t: "lit";
  readonly ch: string;
} | {
  readonly t: "any";
} | {
  readonly t: "cls";
  readonly ranges: readonly Range[];
  readonly negate: boolean;
} | {
  readonly t: "group";
  readonly node: Node;
} | {
  readonly t: "empty";
};
interface Part {
  readonly atom: Atom;
  readonly min: number;
  readonly max: number;
}
type Node = {
  readonly t: "seq";
  readonly parts: readonly Part[];
} | {
  readonly t: "alt";
  readonly options: readonly Node[];
};

/** `\d`/`\w`/`\s` → code-point ranges (lowercase keys). */
const CLASS_ESCAPE_RANGES: Readonly<Partial<Record<"d" | "w" | "s", readonly Range[]>>> = stryMutAct_9fa48("1368") ? {} : (stryCov_9fa48("1368"), {
  d: stryMutAct_9fa48("1369") ? [] : (stryCov_9fa48("1369"), [stryMutAct_9fa48("1370") ? [] : (stryCov_9fa48("1370"), [0x30, 0x39])]),
  w: stryMutAct_9fa48("1371") ? [] : (stryCov_9fa48("1371"), [stryMutAct_9fa48("1372") ? [] : (stryCov_9fa48("1372"), [0x30, 0x39]), stryMutAct_9fa48("1373") ? [] : (stryCov_9fa48("1373"), [0x41, 0x5a]), stryMutAct_9fa48("1374") ? [] : (stryCov_9fa48("1374"), [0x5f, 0x5f]), stryMutAct_9fa48("1375") ? [] : (stryCov_9fa48("1375"), [0x61, 0x7a])]),
  s: stryMutAct_9fa48("1376") ? [] : (stryCov_9fa48("1376"), [stryMutAct_9fa48("1377") ? [] : (stryCov_9fa48("1377"), [0x09, 0x0d]), stryMutAct_9fa48("1378") ? [] : (stryCov_9fa48("1378"), [0x20, 0x20])])
});
class Parser {
  pos = 0;
  constructor(private readonly src: string) {}
  private peek(): string {
    if (stryMutAct_9fa48("1379")) {
      {}
    } else {
      stryCov_9fa48("1379");
      return stryMutAct_9fa48("1380") ? this.src[this.pos] && "" : (stryCov_9fa48("1380"), this.src[this.pos] ?? (stryMutAct_9fa48("1381") ? "Stryker was here!" : (stryCov_9fa48("1381"), "")));
    }
  }
  private next(): string {
    if (stryMutAct_9fa48("1382")) {
      {}
    } else {
      stryCov_9fa48("1382");
      return stryMutAct_9fa48("1383") ? this.src[this.pos++] && "" : (stryCov_9fa48("1383"), this.src[stryMutAct_9fa48("1384") ? this.pos-- : (stryCov_9fa48("1384"), this.pos++)] ?? (stryMutAct_9fa48("1385") ? "Stryker was here!" : (stryCov_9fa48("1385"), "")));
    }
  }
  parse(): Node {
    if (stryMutAct_9fa48("1386")) {
      {}
    } else {
      stryCov_9fa48("1386");
      const node = this.parseAlt();
      if (stryMutAct_9fa48("1389") ? this.pos === this.src.length : stryMutAct_9fa48("1388") ? false : stryMutAct_9fa48("1387") ? true : (stryCov_9fa48("1387", "1388", "1389"), this.pos !== this.src.length)) {
        if (stryMutAct_9fa48("1390")) {
          {}
        } else {
          stryCov_9fa48("1390");
          throw new SeedError(stryMutAct_9fa48("1392") ? `` : (stryCov_9fa48("1392"), `unsupported pattern syntax at offset ${this.pos}: ${stryMutAct_9fa48("1393") ? this.src : (stryCov_9fa48("1393"), this.src.slice(this.pos))}`));
        }
      }
      return node;
    }
  }
  private parseAlt(): Node {
    if (stryMutAct_9fa48("1394")) {
      {}
    } else {
      stryCov_9fa48("1394");
      const options = stryMutAct_9fa48("1395") ? [] : (stryCov_9fa48("1395"), [this.parseSeq()]);
      while (stryMutAct_9fa48("1397") ? this.peek() !== "|" : stryMutAct_9fa48("1396") ? false : (stryCov_9fa48("1396", "1397"), this.peek() === (stryMutAct_9fa48("1398") ? "" : (stryCov_9fa48("1398"), "|")))) {
        if (stryMutAct_9fa48("1399")) {
          {}
        } else {
          stryCov_9fa48("1399");
          if (stryMutAct_9fa48("1400")) {
            ;
          } else {
            stryCov_9fa48("1400");
            this.next();
          }
          if (stryMutAct_9fa48("1401")) {
            ;
          } else {
            stryCov_9fa48("1401");
            options.push(this.parseSeq());
          }
        }
      }
      return (stryMutAct_9fa48("1404") ? options.length !== 1 : stryMutAct_9fa48("1403") ? false : stryMutAct_9fa48("1402") ? true : (stryCov_9fa48("1402", "1403", "1404"), options.length === 1)) ? options[0] as Node : stryMutAct_9fa48("1405") ? {} : (stryCov_9fa48("1405"), {
        t: stryMutAct_9fa48("1406") ? "" : (stryCov_9fa48("1406"), "alt"),
        options
      });
    }
  }
  private parseSeq(): Node {
    if (stryMutAct_9fa48("1407")) {
      {}
    } else {
      stryCov_9fa48("1407");
      const parts: Part[] = stryMutAct_9fa48("1408") ? ["Stryker was here"] : (stryCov_9fa48("1408"), []);
      while (stryMutAct_9fa48("1410") ? this.pos < this.src.length && this.peek() !== ")" || this.peek() !== "|" : stryMutAct_9fa48("1409") ? false : (stryCov_9fa48("1409", "1410"), (stryMutAct_9fa48("1412") ? this.pos < this.src.length || this.peek() !== ")" : stryMutAct_9fa48("1411") ? true : (stryCov_9fa48("1411", "1412"), (stryMutAct_9fa48("1415") ? this.pos >= this.src.length : stryMutAct_9fa48("1414") ? this.pos <= this.src.length : stryMutAct_9fa48("1413") ? true : (stryCov_9fa48("1413", "1414", "1415"), this.pos < this.src.length)) && (stryMutAct_9fa48("1417") ? this.peek() === ")" : stryMutAct_9fa48("1416") ? true : (stryCov_9fa48("1416", "1417"), this.peek() !== (stryMutAct_9fa48("1418") ? "" : (stryCov_9fa48("1418"), ")")))))) && (stryMutAct_9fa48("1420") ? this.peek() === "|" : stryMutAct_9fa48("1419") ? true : (stryCov_9fa48("1419", "1420"), this.peek() !== (stryMutAct_9fa48("1421") ? "" : (stryCov_9fa48("1421"), "|")))))) {
        if (stryMutAct_9fa48("1422")) {
          {}
        } else {
          stryCov_9fa48("1422");
          if (stryMutAct_9fa48("1423")) {
            ;
          } else {
            stryCov_9fa48("1423");
            parts.push(this.parseRepeat());
          }
        }
      }
      return stryMutAct_9fa48("1424") ? {} : (stryCov_9fa48("1424"), {
        t: stryMutAct_9fa48("1425") ? "" : (stryCov_9fa48("1425"), "seq"),
        parts
      });
    }
  }
  private parseRepeat(): Part {
    if (stryMutAct_9fa48("1426")) {
      {}
    } else {
      stryCov_9fa48("1426");
      const atom = this.parseAtom();
      const c = this.peek();
      let min = 1;
      let max = 1;
      if (stryMutAct_9fa48("1429") ? c !== "*" : stryMutAct_9fa48("1428") ? false : stryMutAct_9fa48("1427") ? true : (stryCov_9fa48("1427", "1428", "1429"), c === (stryMutAct_9fa48("1430") ? "" : (stryCov_9fa48("1430"), "*")))) {
        if (stryMutAct_9fa48("1431")) {
          {}
        } else {
          stryCov_9fa48("1431");
          if (stryMutAct_9fa48("1432")) {
            ;
          } else {
            stryCov_9fa48("1432");
            this.next();
          }
          min = 0;
          max = UNBOUNDED_MAX;
        }
      } else if (stryMutAct_9fa48("1435") ? c !== "+" : stryMutAct_9fa48("1434") ? false : stryMutAct_9fa48("1433") ? true : (stryCov_9fa48("1433", "1434", "1435"), c === (stryMutAct_9fa48("1436") ? "" : (stryCov_9fa48("1436"), "+")))) {
        if (stryMutAct_9fa48("1437")) {
          {}
        } else {
          stryCov_9fa48("1437");
          if (stryMutAct_9fa48("1438")) {
            ;
          } else {
            stryCov_9fa48("1438");
            this.next();
          }
          min = 1;
          max = UNBOUNDED_MAX;
        }
      } else if (stryMutAct_9fa48("1441") ? c !== "?" : stryMutAct_9fa48("1440") ? false : stryMutAct_9fa48("1439") ? true : (stryCov_9fa48("1439", "1440", "1441"), c === (stryMutAct_9fa48("1442") ? "" : (stryCov_9fa48("1442"), "?")))) {
        if (stryMutAct_9fa48("1443")) {
          {}
        } else {
          stryCov_9fa48("1443");
          if (stryMutAct_9fa48("1444")) {
            ;
          } else {
            stryCov_9fa48("1444");
            this.next();
          }
          min = 0;
          max = 1;
        }
      } else if (stryMutAct_9fa48("1447") ? c !== "{" : stryMutAct_9fa48("1446") ? false : stryMutAct_9fa48("1445") ? true : (stryCov_9fa48("1445", "1446", "1447"), c === (stryMutAct_9fa48("1448") ? "" : (stryCov_9fa48("1448"), "{")))) {
        if (stryMutAct_9fa48("1449")) {
          {}
        } else {
          stryCov_9fa48("1449");
          const m = (stryMutAct_9fa48("1455") ? /^\{(\d+)(?:,(\D*))?\}/ : stryMutAct_9fa48("1454") ? /^\{(\d+)(?:,(\d))?\}/ : stryMutAct_9fa48("1453") ? /^\{(\d+)(?:,(\d*))\}/ : stryMutAct_9fa48("1452") ? /^\{(\D+)(?:,(\d*))?\}/ : stryMutAct_9fa48("1451") ? /^\{(\d)(?:,(\d*))?\}/ : stryMutAct_9fa48("1450") ? /\{(\d+)(?:,(\d*))?\}/ : (stryCov_9fa48("1450", "1451", "1452", "1453", "1454", "1455"), /^\{(\d+)(?:,(\d*))?\}/)).exec(stryMutAct_9fa48("1456") ? this.src : (stryCov_9fa48("1456"), this.src.slice(this.pos)));
          if (stryMutAct_9fa48("1459") ? false : stryMutAct_9fa48("1458") ? true : stryMutAct_9fa48("1457") ? m : (stryCov_9fa48("1457", "1458", "1459"), !m)) throw new SeedError(stryMutAct_9fa48("1461") ? `` : (stryCov_9fa48("1461"), `unsupported quantifier at offset ${this.pos}`));
          stryMutAct_9fa48("1462") ? this.pos -= m[0].length : (stryCov_9fa48("1462"), this.pos += m[0].length);
          min = Number(m[1]);
          max = (stryMutAct_9fa48("1465") ? m[2] !== undefined : stryMutAct_9fa48("1464") ? false : stryMutAct_9fa48("1463") ? true : (stryCov_9fa48("1463", "1464", "1465"), m[2] === undefined)) ? min : (stryMutAct_9fa48("1468") ? m[2] !== "" : stryMutAct_9fa48("1467") ? false : stryMutAct_9fa48("1466") ? true : (stryCov_9fa48("1466", "1467", "1468"), m[2] === (stryMutAct_9fa48("1469") ? "Stryker was here!" : (stryCov_9fa48("1469"), "")))) ? MAX_REPEAT : Number(m[2]);
          if (stryMutAct_9fa48("1473") ? max <= MAX_REPEAT : stryMutAct_9fa48("1472") ? max >= MAX_REPEAT : stryMutAct_9fa48("1471") ? false : stryMutAct_9fa48("1470") ? true : (stryCov_9fa48("1470", "1471", "1472", "1473"), max > MAX_REPEAT)) max = MAX_REPEAT;
        }
      } else {
        if (stryMutAct_9fa48("1474")) {
          {}
        } else {
          stryCov_9fa48("1474");
          return stryMutAct_9fa48("1475") ? {} : (stryCov_9fa48("1475"), {
            atom,
            min: 1,
            max: 1
          });
        }
      }
      if (stryMutAct_9fa48("1479") ? min <= MAX_REPEAT : stryMutAct_9fa48("1478") ? min >= MAX_REPEAT : stryMutAct_9fa48("1477") ? false : stryMutAct_9fa48("1476") ? true : (stryCov_9fa48("1476", "1477", "1478", "1479"), min > MAX_REPEAT)) min = MAX_REPEAT;
      if (stryMutAct_9fa48("1482") ? this.peek() !== "?" : stryMutAct_9fa48("1481") ? false : stryMutAct_9fa48("1480") ? true : (stryCov_9fa48("1480", "1481", "1482"), this.peek() === (stryMutAct_9fa48("1483") ? "" : (stryCov_9fa48("1483"), "?")))) if (stryMutAct_9fa48("1484")) {
        ;
      } else {
        stryCov_9fa48("1484");
        this.next();
      } // lazy suffix — same language
      return stryMutAct_9fa48("1485") ? {} : (stryCov_9fa48("1485"), {
        atom,
        min,
        max
      });
    }
  }
  private parseAtom(): Atom {
    if (stryMutAct_9fa48("1486")) {
      {}
    } else {
      stryCov_9fa48("1486");
      const c = this.next();
      switch (c) {
        // parseSeq only calls parseAtom while pos < length, so c is
        // never "" here — an empty lit would emit nothing anyway.
        case stryMutAct_9fa48("1488") ? "" : (stryCov_9fa48("1488"), "("):
          if (stryMutAct_9fa48("1487")) {} else {
            stryCov_9fa48("1487");
            {
              if (stryMutAct_9fa48("1489")) {
                {}
              } else {
                stryCov_9fa48("1489");
                if (stryMutAct_9fa48("1492") ? this.peek() !== "?" : stryMutAct_9fa48("1491") ? false : stryMutAct_9fa48("1490") ? true : (stryCov_9fa48("1490", "1491", "1492"), this.peek() === (stryMutAct_9fa48("1493") ? "" : (stryCov_9fa48("1493"), "?")))) {
                  if (stryMutAct_9fa48("1494")) {
                    {}
                  } else {
                    stryCov_9fa48("1494");
                    if (stryMutAct_9fa48("1495")) {
                      ;
                    } else {
                      stryCov_9fa48("1495");
                      this.next();
                    } // '?'
                    const marker = this.next();
                    if (stryMutAct_9fa48("1498") ? marker === ":" : stryMutAct_9fa48("1497") ? false : stryMutAct_9fa48("1496") ? true : (stryCov_9fa48("1496", "1497", "1498"), marker !== (stryMutAct_9fa48("1499") ? "" : (stryCov_9fa48("1499"), ":")))) {
                      if (stryMutAct_9fa48("1500")) {
                        {}
                      } else {
                        stryCov_9fa48("1500");
                        throw new SeedError(stryMutAct_9fa48("1502") ? `` : (stryCov_9fa48("1502"), `unsupported group syntax "(?${marker}"`));
                      }
                    }
                  }
                }
                const node = this.parseAlt();
                if (stryMutAct_9fa48("1505") ? this.next() === ")" : stryMutAct_9fa48("1504") ? false : stryMutAct_9fa48("1503") ? true : (stryCov_9fa48("1503", "1504", "1505"), this.next() !== (stryMutAct_9fa48("1506") ? "" : (stryCov_9fa48("1506"), ")")))) throw new SeedError(stryMutAct_9fa48("1508") ? "" : (stryCov_9fa48("1508"), "unterminated group"));
                return stryMutAct_9fa48("1509") ? {} : (stryCov_9fa48("1509"), {
                  t: stryMutAct_9fa48("1510") ? "" : (stryCov_9fa48("1510"), "group"),
                  node
                });
              }
            }
          }
        case stryMutAct_9fa48("1512") ? "" : (stryCov_9fa48("1512"), "["):
          if (stryMutAct_9fa48("1511")) {} else {
            stryCov_9fa48("1511");
            return this.parseClass();
          }
        case stryMutAct_9fa48("1514") ? "" : (stryCov_9fa48("1514"), "."):
          if (stryMutAct_9fa48("1513")) {} else {
            stryCov_9fa48("1513");
            return stryMutAct_9fa48("1515") ? {} : (stryCov_9fa48("1515"), {
              t: stryMutAct_9fa48("1516") ? "" : (stryCov_9fa48("1516"), "any")
            });
          }
        case stryMutAct_9fa48("1517") ? "" : (stryCov_9fa48("1517"), "^"):
        case stryMutAct_9fa48("1519") ? "" : (stryCov_9fa48("1519"), "$"):
          if (stryMutAct_9fa48("1518")) {} else {
            stryCov_9fa48("1518");
            return stryMutAct_9fa48("1520") ? {} : (stryCov_9fa48("1520"), {
              t: stryMutAct_9fa48("1521") ? "" : (stryCov_9fa48("1521"), "empty")
            });
          }
        case stryMutAct_9fa48("1523") ? "" : (stryCov_9fa48("1523"), "\\"):
          if (stryMutAct_9fa48("1522")) {} else {
            stryCov_9fa48("1522");
            return this.parseEscape();
          }
        default:
          if (stryMutAct_9fa48("1524")) {} else {
            stryCov_9fa48("1524");
            return stryMutAct_9fa48("1525") ? {} : (stryCov_9fa48("1525"), {
              t: stryMutAct_9fa48("1526") ? "" : (stryCov_9fa48("1526"), "lit"),
              ch: c
            });
          }
      }
    }
  }
  private parseClass(): Atom {
    if (stryMutAct_9fa48("1527")) {
      {}
    } else {
      stryCov_9fa48("1527");
      let negate = stryMutAct_9fa48("1528") ? true : (stryCov_9fa48("1528"), false);
      if (stryMutAct_9fa48("1531") ? this.peek() !== "^" : stryMutAct_9fa48("1530") ? false : stryMutAct_9fa48("1529") ? true : (stryCov_9fa48("1529", "1530", "1531"), this.peek() === (stryMutAct_9fa48("1532") ? "" : (stryCov_9fa48("1532"), "^")))) {
        if (stryMutAct_9fa48("1533")) {
          {}
        } else {
          stryCov_9fa48("1533");
          if (stryMutAct_9fa48("1534")) {
            ;
          } else {
            stryCov_9fa48("1534");
            this.next();
          }
          negate = stryMutAct_9fa48("1535") ? false : (stryCov_9fa48("1535"), true);
        }
      }
      const ranges: Range[] = stryMutAct_9fa48("1536") ? ["Stryker was here"] : (stryCov_9fa48("1536"), []);
      // JS semantics: "]" ALWAYS closes the class — "[]" is an empty
      // (unsatisfiable) class and "[^]" matches any char. No POSIX
      // literal-]-first rule.
      while (stryMutAct_9fa48("1539") ? this.pos >= this.src.length : stryMutAct_9fa48("1538") ? this.pos <= this.src.length : stryMutAct_9fa48("1537") ? false : (stryCov_9fa48("1537", "1538", "1539"), this.pos < this.src.length)) {
        if (stryMutAct_9fa48("1540")) {
          {}
        } else {
          stryCov_9fa48("1540");
          if (stryMutAct_9fa48("1543") ? this.peek() !== "]" : stryMutAct_9fa48("1542") ? false : stryMutAct_9fa48("1541") ? true : (stryCov_9fa48("1541", "1542", "1543"), this.peek() === (stryMutAct_9fa48("1544") ? "" : (stryCov_9fa48("1544"), "]")))) {
            if (stryMutAct_9fa48("1545")) {
              {}
            } else {
              stryCov_9fa48("1545");
              if (stryMutAct_9fa48("1546")) {
                ;
              } else {
                stryCov_9fa48("1546");
                this.next();
              }
              return stryMutAct_9fa48("1547") ? {} : (stryCov_9fa48("1547"), {
                t: stryMutAct_9fa48("1548") ? "" : (stryCov_9fa48("1548"), "cls"),
                ranges,
                negate
              });
            }
          }
          // Class escapes inside [] contribute a whole set — they can't
          // be range endpoints, so handle them before range parsing.
          // NOTE: src[pos+1] may be undefined at end-of-input — guard
          // explicitly (RegExp.test would coerce it to "undefined").
          const nextCh = this.src[stryMutAct_9fa48("1549") ? this.pos - 1 : (stryCov_9fa48("1549"), this.pos + 1)];
          if (stryMutAct_9fa48("1552") ? this.peek() === "\\" && nextCh !== undefined || /[dDwWsS]/.test(nextCh) : stryMutAct_9fa48("1551") ? false : stryMutAct_9fa48("1550") ? true : (stryCov_9fa48("1550", "1551", "1552"), (stryMutAct_9fa48("1554") ? this.peek() === "\\" || nextCh !== undefined : stryMutAct_9fa48("1553") ? true : (stryCov_9fa48("1553", "1554"), (stryMutAct_9fa48("1556") ? this.peek() !== "\\" : stryMutAct_9fa48("1555") ? true : (stryCov_9fa48("1555", "1556"), this.peek() === (stryMutAct_9fa48("1557") ? "" : (stryCov_9fa48("1557"), "\\")))) && (stryMutAct_9fa48("1559") ? nextCh === undefined : stryMutAct_9fa48("1558") ? true : (stryCov_9fa48("1558", "1559"), nextCh !== undefined)))) && (stryMutAct_9fa48("1560") ? /[^dDwWsS]/ : (stryCov_9fa48("1560"), /[dDwWsS]/)).test(nextCh))) {
            if (stryMutAct_9fa48("1561")) {
              {}
            } else {
              stryCov_9fa48("1561");
              if (stryMutAct_9fa48("1562")) {
                ;
              } else {
                stryCov_9fa48("1562");
                this.next();
              }
              const e = this.next();
              const inner = CLASS_ESCAPE_RANGES[e.toLowerCase() as "d" | "w" | "s"] as Range[];
              // Negated inner escape ([\D] ≈ non-digits): approximate with
              // the printable complement — the caller's RegExp verify
              // step catches any mismatch.
              if (stryMutAct_9fa48("1565") ? (e === "D" || e === "W") && e === "S" : stryMutAct_9fa48("1564") ? false : stryMutAct_9fa48("1563") ? true : (stryCov_9fa48("1563", "1564", "1565"), (stryMutAct_9fa48("1567") ? e === "D" && e === "W" : stryMutAct_9fa48("1566") ? false : (stryCov_9fa48("1566", "1567"), (stryMutAct_9fa48("1569") ? e !== "D" : stryMutAct_9fa48("1568") ? false : (stryCov_9fa48("1568", "1569"), e === (stryMutAct_9fa48("1570") ? "" : (stryCov_9fa48("1570"), "D")))) || (stryMutAct_9fa48("1572") ? e !== "W" : stryMutAct_9fa48("1571") ? false : (stryCov_9fa48("1571", "1572"), e === (stryMutAct_9fa48("1573") ? "" : (stryCov_9fa48("1573"), "W")))))) || (stryMutAct_9fa48("1575") ? e !== "S" : stryMutAct_9fa48("1574") ? false : (stryCov_9fa48("1574", "1575"), e === (stryMutAct_9fa48("1576") ? "" : (stryCov_9fa48("1576"), "S")))))) {
                if (stryMutAct_9fa48("1577")) {
                  {}
                } else {
                  stryCov_9fa48("1577");
                  for (const r of complement(inner)) if (stryMutAct_9fa48("1578")) {
                    ;
                  } else {
                    stryCov_9fa48("1578");
                    ranges.push(r);
                  }
                }
              } else {
                if (stryMutAct_9fa48("1579")) {
                  {}
                } else {
                  stryCov_9fa48("1579");
                  if (stryMutAct_9fa48("1580")) {
                    ;
                  } else {
                    stryCov_9fa48("1580");
                    ranges.push(...inner);
                  }
                }
              }
              continue;
            }
          }
          const lo = this.parseClassChar();
          if (stryMutAct_9fa48("1583") ? this.peek() === "-" || this.src[this.pos + 1] !== "]" : stryMutAct_9fa48("1582") ? false : stryMutAct_9fa48("1581") ? true : (stryCov_9fa48("1581", "1582", "1583"), (stryMutAct_9fa48("1585") ? this.peek() !== "-" : stryMutAct_9fa48("1584") ? true : (stryCov_9fa48("1584", "1585"), this.peek() === (stryMutAct_9fa48("1586") ? "" : (stryCov_9fa48("1586"), "-")))) && (stryMutAct_9fa48("1588") ? this.src[this.pos + 1] === "]" : stryMutAct_9fa48("1587") ? true : (stryCov_9fa48("1587", "1588"), this.src[stryMutAct_9fa48("1589") ? this.pos - 1 : (stryCov_9fa48("1589"), this.pos + 1)] !== (stryMutAct_9fa48("1590") ? "" : (stryCov_9fa48("1590"), "]")))))) {
            if (stryMutAct_9fa48("1591")) {
              {}
            } else {
              stryCov_9fa48("1591");
              if (stryMutAct_9fa48("1592")) {
                ;
              } else {
                stryCov_9fa48("1592");
                this.next();
              }
              const hi = this.parseClassChar();
              if (stryMutAct_9fa48("1596") ? hi >= lo : stryMutAct_9fa48("1595") ? hi <= lo : stryMutAct_9fa48("1594") ? false : stryMutAct_9fa48("1593") ? true : (stryCov_9fa48("1593", "1594", "1595", "1596"), hi < lo)) throw new SeedError(stryMutAct_9fa48("1598") ? "" : (stryCov_9fa48("1598"), "reversed character range"));
              ranges.push(stryMutAct_9fa48("1600") ? [] : (stryCov_9fa48("1600"), [lo, hi]));
            }
          } else {
            if (stryMutAct_9fa48("1601")) {
              {}
            } else {
              stryCov_9fa48("1601");
              ranges.push(stryMutAct_9fa48("1603") ? [] : (stryCov_9fa48("1603"), [lo, lo]));
            }
          }
        }
      }
      throw new SeedError(stryMutAct_9fa48("1605") ? "" : (stryCov_9fa48("1605"), "unterminated character class"));
    }
  }

  /** One class item → code point (class escapes are handled by the
   * caller before this runs). */
  private parseClassChar(): number {
    if (stryMutAct_9fa48("1606")) {
      {}
    } else {
      stryCov_9fa48("1606");
      const c = this.next();
      if (stryMutAct_9fa48("1609") ? c !== "\\" : stryMutAct_9fa48("1608") ? false : stryMutAct_9fa48("1607") ? true : (stryCov_9fa48("1607", "1608", "1609"), c === (stryMutAct_9fa48("1610") ? "" : (stryCov_9fa48("1610"), "\\")))) {
        if (stryMutAct_9fa48("1611")) {
          {}
        } else {
          stryCov_9fa48("1611");
          const e = this.next();
          return this.escapeChar(e);
        }
      }
      return c.codePointAt(0) as number;
    }
  }

  /** Parse a `\x` escape outside a class → Atom. */
  private parseEscape(): Atom {
    if (stryMutAct_9fa48("1612")) {
      {}
    } else {
      stryCov_9fa48("1612");
      const e = this.next();
      if (stryMutAct_9fa48("1615") ? e !== "" : stryMutAct_9fa48("1614") ? false : stryMutAct_9fa48("1613") ? true : (stryCov_9fa48("1613", "1614", "1615"), e === (stryMutAct_9fa48("1616") ? "Stryker was here!" : (stryCov_9fa48("1616"), "")))) throw new SeedError(stryMutAct_9fa48("1618") ? "" : (stryCov_9fa48("1618"), "trailing backslash"));
      if (stryMutAct_9fa48("1620") ? false : stryMutAct_9fa48("1619") ? true : (stryCov_9fa48("1619", "1620"), (stryMutAct_9fa48("1623") ? /^[^1-9]$/ : stryMutAct_9fa48("1622") ? /^[1-9]/ : stryMutAct_9fa48("1621") ? /[1-9]$/ : (stryCov_9fa48("1621", "1622", "1623"), /^[1-9]$/)).test(e))) throw new SeedError(stryMutAct_9fa48("1625") ? `` : (stryCov_9fa48("1625"), `backreference \\${e} unsupported`));
      // Negated class escapes are classes with negate flipped.
      if (stryMutAct_9fa48("1628") ? (e === "D" || e === "W") && e === "S" : stryMutAct_9fa48("1627") ? false : stryMutAct_9fa48("1626") ? true : (stryCov_9fa48("1626", "1627", "1628"), (stryMutAct_9fa48("1630") ? e === "D" && e === "W" : stryMutAct_9fa48("1629") ? false : (stryCov_9fa48("1629", "1630"), (stryMutAct_9fa48("1632") ? e !== "D" : stryMutAct_9fa48("1631") ? false : (stryCov_9fa48("1631", "1632"), e === (stryMutAct_9fa48("1633") ? "" : (stryCov_9fa48("1633"), "D")))) || (stryMutAct_9fa48("1635") ? e !== "W" : stryMutAct_9fa48("1634") ? false : (stryCov_9fa48("1634", "1635"), e === (stryMutAct_9fa48("1636") ? "" : (stryCov_9fa48("1636"), "W")))))) || (stryMutAct_9fa48("1638") ? e !== "S" : stryMutAct_9fa48("1637") ? false : (stryCov_9fa48("1637", "1638"), e === (stryMutAct_9fa48("1639") ? "" : (stryCov_9fa48("1639"), "S")))))) {
        if (stryMutAct_9fa48("1640")) {
          {}
        } else {
          stryCov_9fa48("1640");
          return stryMutAct_9fa48("1641") ? {} : (stryCov_9fa48("1641"), {
            t: stryMutAct_9fa48("1642") ? "" : (stryCov_9fa48("1642"), "cls"),
            ranges: CLASS_ESCAPE_RANGES[e.toLowerCase() as "d" | "w" | "s"] as Range[],
            negate: stryMutAct_9fa48("1643") ? false : (stryCov_9fa48("1643"), true)
          });
        }
      }
      const ranges = this.escapeRanges(e);
      if (stryMutAct_9fa48("1645") ? false : stryMutAct_9fa48("1644") ? true : (stryCov_9fa48("1644", "1645"), ranges)) return stryMutAct_9fa48("1646") ? {} : (stryCov_9fa48("1646"), {
        t: stryMutAct_9fa48("1647") ? "" : (stryCov_9fa48("1647"), "cls"),
        ranges,
        negate: stryMutAct_9fa48("1648") ? true : (stryCov_9fa48("1648"), false)
      });
      if (stryMutAct_9fa48("1651") ? e === "b" && e === "B" : stryMutAct_9fa48("1650") ? false : stryMutAct_9fa48("1649") ? true : (stryCov_9fa48("1649", "1650", "1651"), (stryMutAct_9fa48("1653") ? e !== "b" : stryMutAct_9fa48("1652") ? false : (stryCov_9fa48("1652", "1653"), e === (stryMutAct_9fa48("1654") ? "" : (stryCov_9fa48("1654"), "b")))) || (stryMutAct_9fa48("1656") ? e !== "B" : stryMutAct_9fa48("1655") ? false : (stryCov_9fa48("1655", "1656"), e === (stryMutAct_9fa48("1657") ? "" : (stryCov_9fa48("1657"), "B")))))) return stryMutAct_9fa48("1658") ? {} : (stryCov_9fa48("1658"), {
        t: stryMutAct_9fa48("1659") ? "" : (stryCov_9fa48("1659"), "empty")
      }); // word boundary — zero-width
      return stryMutAct_9fa48("1660") ? {} : (stryCov_9fa48("1660"), {
        t: stryMutAct_9fa48("1661") ? "" : (stryCov_9fa48("1661"), "lit"),
        ch: String.fromCodePoint(this.escapeChar(e))
      });
    }
  }

  /** Class escapes → code-point ranges via the shared table (only
   * positive `d`/`w`/`s` reach here — negated forms are intercepted
   * in {@link parseEscape} first). */
  private escapeRanges(e: string): readonly Range[] | undefined {
    if (stryMutAct_9fa48("1662")) {
      {}
    } else {
      stryCov_9fa48("1662");
      return CLASS_ESCAPE_RANGES[e as "d" | "w" | "s"];
    }
  }

  /** Non-class escape → code point. */
  private escapeChar(e: string): number {
    if (stryMutAct_9fa48("1663")) {
      {}
    } else {
      stryCov_9fa48("1663");
      if (stryMutAct_9fa48("1666") ? e !== "" : stryMutAct_9fa48("1665") ? false : stryMutAct_9fa48("1664") ? true : (stryCov_9fa48("1664", "1665", "1666"), e === (stryMutAct_9fa48("1667") ? "Stryker was here!" : (stryCov_9fa48("1667"), "")))) throw new SeedError(stryMutAct_9fa48("1669") ? "" : (stryCov_9fa48("1669"), "trailing backslash"));
      switch (e) {
        case stryMutAct_9fa48("1671") ? "" : (stryCov_9fa48("1671"), "n"):
          if (stryMutAct_9fa48("1670")) {} else {
            stryCov_9fa48("1670");
            return 0x0a;
          }
        case stryMutAct_9fa48("1673") ? "" : (stryCov_9fa48("1673"), "t"):
          if (stryMutAct_9fa48("1672")) {} else {
            stryCov_9fa48("1672");
            return 0x09;
          }
        case stryMutAct_9fa48("1675") ? "" : (stryCov_9fa48("1675"), "r"):
          if (stryMutAct_9fa48("1674")) {} else {
            stryCov_9fa48("1674");
            return 0x0d;
          }
        case stryMutAct_9fa48("1677") ? "" : (stryCov_9fa48("1677"), "f"):
          if (stryMutAct_9fa48("1676")) {} else {
            stryCov_9fa48("1676");
            return 0x0c;
          }
        case stryMutAct_9fa48("1679") ? "" : (stryCov_9fa48("1679"), "v"):
          if (stryMutAct_9fa48("1678")) {} else {
            stryCov_9fa48("1678");
            return 0x0b;
          }
        case stryMutAct_9fa48("1681") ? "" : (stryCov_9fa48("1681"), "0"):
          if (stryMutAct_9fa48("1680")) {} else {
            stryCov_9fa48("1680");
            return 0x00;
          }
        case stryMutAct_9fa48("1683") ? "" : (stryCov_9fa48("1683"), "b"):
          if (stryMutAct_9fa48("1682")) {} else {
            stryCov_9fa48("1682");
            // Inside a class \b is backspace (outside it parseEscape
            // intercepts it as a zero-width boundary first).
            return 0x08;
          }
        case stryMutAct_9fa48("1685") ? "" : (stryCov_9fa48("1685"), "x"):
          if (stryMutAct_9fa48("1684")) {} else {
            stryCov_9fa48("1684");
            {
              if (stryMutAct_9fa48("1686")) {
                {}
              } else {
                stryCov_9fa48("1686");
                const h = stryMutAct_9fa48("1687") ? this.src : (stryCov_9fa48("1687"), this.src.slice(this.pos, stryMutAct_9fa48("1688") ? this.pos - 2 : (stryCov_9fa48("1688"), this.pos + 2)));
                if (stryMutAct_9fa48("1691") ? false : stryMutAct_9fa48("1690") ? true : stryMutAct_9fa48("1689") ? /^[0-9a-fA-F]{2}$/.test(h) : (stryCov_9fa48("1689", "1690", "1691"), !(stryMutAct_9fa48("1695") ? /^[^0-9a-fA-F]{2}$/ : stryMutAct_9fa48("1694") ? /^[0-9a-fA-F]$/ : stryMutAct_9fa48("1693") ? /^[0-9a-fA-F]{2}/ : stryMutAct_9fa48("1692") ? /[0-9a-fA-F]{2}$/ : (stryCov_9fa48("1692", "1693", "1694", "1695"), /^[0-9a-fA-F]{2}$/)).test(h))) throw new SeedError(stryMutAct_9fa48("1697") ? "" : (stryCov_9fa48("1697"), "bad \\x escape"));
                stryMutAct_9fa48("1698") ? this.pos -= 2 : (stryCov_9fa48("1698"), this.pos += 2);
                return parseInt(h, 16);
              }
            }
          }
        case stryMutAct_9fa48("1700") ? "" : (stryCov_9fa48("1700"), "u"):
          if (stryMutAct_9fa48("1699")) {} else {
            stryCov_9fa48("1699");
            {
              if (stryMutAct_9fa48("1701")) {
                {}
              } else {
                stryCov_9fa48("1701");
                const h = stryMutAct_9fa48("1702") ? this.src : (stryCov_9fa48("1702"), this.src.slice(this.pos, stryMutAct_9fa48("1703") ? this.pos - 4 : (stryCov_9fa48("1703"), this.pos + 4)));
                if (stryMutAct_9fa48("1706") ? false : stryMutAct_9fa48("1705") ? true : stryMutAct_9fa48("1704") ? /^[0-9a-fA-F]{4}$/.test(h) : (stryCov_9fa48("1704", "1705", "1706"), !(stryMutAct_9fa48("1710") ? /^[^0-9a-fA-F]{4}$/ : stryMutAct_9fa48("1709") ? /^[0-9a-fA-F]$/ : stryMutAct_9fa48("1708") ? /^[0-9a-fA-F]{4}/ : stryMutAct_9fa48("1707") ? /[0-9a-fA-F]{4}$/ : (stryCov_9fa48("1707", "1708", "1709", "1710"), /^[0-9a-fA-F]{4}$/)).test(h))) throw new SeedError(stryMutAct_9fa48("1712") ? "" : (stryCov_9fa48("1712"), "bad \\u escape"));
                stryMutAct_9fa48("1713") ? this.pos -= 4 : (stryCov_9fa48("1713"), this.pos += 4);
                return parseInt(h, 16);
              }
            }
          }
        default:
          if (stryMutAct_9fa48("1714")) {} else {
            stryCov_9fa48("1714");
            // Escaped punctuation/literal (\., \\, \/, \-, …) — the
            // backslash quotes the char.
            return e.codePointAt(0) as number;
          }
      }
    }
  }
}
interface GenState {
  out: string;
  readonly limit: number;
}
const emit = (st: GenState, s: string): void => {
  if (stryMutAct_9fa48("1715")) {
    {}
  } else {
    stryCov_9fa48("1715");
    stryMutAct_9fa48("1716") ? st.out -= s : (stryCov_9fa48("1716"), st.out += s);
    if (stryMutAct_9fa48("1720") ? st.out.length <= st.limit : stryMutAct_9fa48("1719") ? st.out.length >= st.limit : stryMutAct_9fa48("1718") ? false : stryMutAct_9fa48("1717") ? true : (stryCov_9fa48("1717", "1718", "1719", "1720"), st.out.length > st.limit)) {
      if (stryMutAct_9fa48("1721")) {
        {}
      } else {
        stryCov_9fa48("1721");
        throw new SeedError(stryMutAct_9fa48("1723") ? `` : (stryCov_9fa48("1723"), `pattern generates more than ${st.limit} chars`));
      }
    }
  }
};
const randomInRanges = (rng: () => number, ranges: readonly Range[], negate: boolean): string => {
  if (stryMutAct_9fa48("1724")) {
    {}
  } else {
    stryCov_9fa48("1724");
    let pool: Range[];
    if (stryMutAct_9fa48("1726") ? false : stryMutAct_9fa48("1725") ? true : (stryCov_9fa48("1725", "1726"), negate)) {
      if (stryMutAct_9fa48("1727")) {
        {}
      } else {
        stryCov_9fa48("1727");
        // Complement within printable ASCII — keeps output sane and
        // still satisfies `[^…]` for typical patterns.
        pool = complement(ranges);
      }
    } else {
      if (stryMutAct_9fa48("1728")) {
        {}
      } else {
        stryCov_9fa48("1728");
        pool = stryMutAct_9fa48("1729") ? [] : (stryCov_9fa48("1729"), [...ranges]);
      }
    }
    const total = pool.reduce(stryMutAct_9fa48("1730") ? () => undefined : (stryCov_9fa48("1730"), (n, [lo, hi]) => stryMutAct_9fa48("1731") ? n - (hi - lo + 1) : (stryCov_9fa48("1731"), n + (stryMutAct_9fa48("1732") ? hi - lo - 1 : (stryCov_9fa48("1732"), (stryMutAct_9fa48("1733") ? hi + lo : (stryCov_9fa48("1733"), hi - lo)) + 1)))), 0);
    if (stryMutAct_9fa48("1737") ? total > 0 : stryMutAct_9fa48("1736") ? total < 0 : stryMutAct_9fa48("1735") ? false : stryMutAct_9fa48("1734") ? true : (stryCov_9fa48("1734", "1735", "1736", "1737"), total <= 0)) throw new SeedError(stryMutAct_9fa48("1739") ? "" : (stryCov_9fa48("1739"), "character class matches nothing generatable"));
    let roll = Math.floor(stryMutAct_9fa48("1740") ? rng() / total : (stryCov_9fa48("1740"), rng() * total));
    for (const [lo, hi] of pool) {
      if (stryMutAct_9fa48("1741")) {
        {}
      } else {
        stryCov_9fa48("1741");
        const size = stryMutAct_9fa48("1742") ? hi - lo - 1 : (stryCov_9fa48("1742"), (stryMutAct_9fa48("1743") ? hi + lo : (stryCov_9fa48("1743"), hi - lo)) + 1);
        if (stryMutAct_9fa48("1747") ? roll >= size : stryMutAct_9fa48("1746") ? roll <= size : stryMutAct_9fa48("1745") ? false : stryMutAct_9fa48("1744") ? true : (stryCov_9fa48("1744", "1745", "1746", "1747"), roll < size)) return String.fromCodePoint(stryMutAct_9fa48("1748") ? lo - roll : (stryCov_9fa48("1748"), lo + roll));
        stryMutAct_9fa48("1749") ? roll += size : (stryCov_9fa48("1749"), roll -= size);
      }
    }
    /* v8 ignore next -- unreachable: roll < total by construction */
    throw new SeedError(stryMutAct_9fa48("1751") ? "" : (stryCov_9fa48("1751"), "character class roll overflow"));
  }
};

/** Complement of `ranges` within [PRINTABLE_LO, PRINTABLE_HI]. */
const complement = (ranges: readonly Range[]): Range[] => {
  if (stryMutAct_9fa48("1752")) {
    {}
  } else {
    stryCov_9fa48("1752");
    const sorted = stryMutAct_9fa48("1753") ? [...ranges] : (stryCov_9fa48("1753"), (stryMutAct_9fa48("1754") ? [] : (stryCov_9fa48("1754"), [...ranges])).sort(stryMutAct_9fa48("1755") ? () => undefined : (stryCov_9fa48("1755"), (a, b) => stryMutAct_9fa48("1756") ? a[0] + b[0] : (stryCov_9fa48("1756"), a[0] - b[0]))));
    const out: Range[] = stryMutAct_9fa48("1757") ? ["Stryker was here"] : (stryCov_9fa48("1757"), []);
    let cur = PRINTABLE_LO;
    for (const [lo, hi] of sorted) {
      if (stryMutAct_9fa48("1758")) {
        {}
      } else {
        stryCov_9fa48("1758");
        const l = stryMutAct_9fa48("1759") ? Math.min(lo, PRINTABLE_LO) : (stryCov_9fa48("1759"), Math.max(lo, PRINTABLE_LO));
        const h = stryMutAct_9fa48("1760") ? Math.max(hi, PRINTABLE_HI) : (stryCov_9fa48("1760"), Math.min(hi, PRINTABLE_HI));
        if (stryMutAct_9fa48("1764") ? h >= cur : stryMutAct_9fa48("1763") ? h <= cur : stryMutAct_9fa48("1762") ? false : stryMutAct_9fa48("1761") ? true : (stryCov_9fa48("1761", "1762", "1763", "1764"), h < cur)) continue;
        if (stryMutAct_9fa48("1768") ? l <= cur : stryMutAct_9fa48("1767") ? l >= cur : stryMutAct_9fa48("1766") ? false : stryMutAct_9fa48("1765") ? true : (stryCov_9fa48("1765", "1766", "1767", "1768"), l > cur)) out.push(stryMutAct_9fa48("1770") ? [] : (stryCov_9fa48("1770"), [cur, stryMutAct_9fa48("1771") ? l + 1 : (stryCov_9fa48("1771"), l - 1)]));
        cur = stryMutAct_9fa48("1772") ? Math.min(cur, h + 1) : (stryCov_9fa48("1772"), Math.max(cur, stryMutAct_9fa48("1773") ? h - 1 : (stryCov_9fa48("1773"), h + 1)));
        if (stryMutAct_9fa48("1777") ? cur <= PRINTABLE_HI : stryMutAct_9fa48("1776") ? cur >= PRINTABLE_HI : stryMutAct_9fa48("1775") ? false : stryMutAct_9fa48("1774") ? true : (stryCov_9fa48("1774", "1775", "1776", "1777"), cur > PRINTABLE_HI)) break;
      }
    }
    if (stryMutAct_9fa48("1781") ? cur > PRINTABLE_HI : stryMutAct_9fa48("1780") ? cur < PRINTABLE_HI : stryMutAct_9fa48("1779") ? false : stryMutAct_9fa48("1778") ? true : (stryCov_9fa48("1778", "1779", "1780", "1781"), cur <= PRINTABLE_HI)) out.push(stryMutAct_9fa48("1783") ? [] : (stryCov_9fa48("1783"), [cur, PRINTABLE_HI]));
    return out;
  }
};
const genAtom = (rng: () => number, st: GenState, atom: Atom): void => {
  if (stryMutAct_9fa48("1784")) {
    {}
  } else {
    stryCov_9fa48("1784");
    switch (atom.t) {
      case stryMutAct_9fa48("1786") ? "" : (stryCov_9fa48("1786"), "lit"):
        if (stryMutAct_9fa48("1785")) {} else {
          stryCov_9fa48("1785");
          if (stryMutAct_9fa48("1787")) {
            ;
          } else {
            stryCov_9fa48("1787");
            emit(st, atom.ch);
          }
          return;
        }
      case stryMutAct_9fa48("1789") ? "" : (stryCov_9fa48("1789"), "empty"):
        if (stryMutAct_9fa48("1788")) {} else {
          stryCov_9fa48("1788");
          return;
        }
      case stryMutAct_9fa48("1791") ? "" : (stryCov_9fa48("1791"), "any"):
        if (stryMutAct_9fa48("1790")) {} else {
          stryCov_9fa48("1790");
          // `.` doesn't match \n by default — emit a printable non-newline.
          emit(st, randomInRanges(rng, stryMutAct_9fa48("1793") ? [] : (stryCov_9fa48("1793"), [stryMutAct_9fa48("1794") ? [] : (stryCov_9fa48("1794"), [0x20, 0x7e])]), stryMutAct_9fa48("1795") ? true : (stryCov_9fa48("1795"), false)));
          return;
        }
      case stryMutAct_9fa48("1797") ? "" : (stryCov_9fa48("1797"), "cls"):
        if (stryMutAct_9fa48("1796")) {} else {
          stryCov_9fa48("1796");
          if (stryMutAct_9fa48("1798")) {
            ;
          } else {
            stryCov_9fa48("1798");
            emit(st, randomInRanges(rng, atom.ranges, atom.negate));
          }
          return;
        }
      case stryMutAct_9fa48("1800") ? "" : (stryCov_9fa48("1800"), "group"):
        if (stryMutAct_9fa48("1799")) {} else {
          stryCov_9fa48("1799");
          if (stryMutAct_9fa48("1801")) {
            ;
          } else {
            stryCov_9fa48("1801");
            genNode(rng, st, atom.node);
          }
          return;
        }
    }
  }
};
const genNode = (rng: () => number, st: GenState, node: Node): void => {
  if (stryMutAct_9fa48("1802")) {
    {}
  } else {
    stryCov_9fa48("1802");
    if (stryMutAct_9fa48("1805") ? node.t !== "alt" : stryMutAct_9fa48("1804") ? false : stryMutAct_9fa48("1803") ? true : (stryCov_9fa48("1803", "1804", "1805"), node.t === (stryMutAct_9fa48("1806") ? "" : (stryCov_9fa48("1806"), "alt")))) {
      if (stryMutAct_9fa48("1807")) {
        {}
      } else {
        stryCov_9fa48("1807");
        const opt = node.options[Math.floor(rng() * node.options.length)] as Node;
        if (stryMutAct_9fa48("1808")) {
          ;
        } else {
          stryCov_9fa48("1808");
          genNode(rng, st, opt);
        }
        return;
      }
    }
    for (const part of node.parts) {
      if (stryMutAct_9fa48("1809")) {
        {}
      } else {
        stryCov_9fa48("1809");
        const count = stryMutAct_9fa48("1810") ? part.min - Math.floor(rng() * (part.max - part.min + 1)) : (stryCov_9fa48("1810"), part.min + Math.floor(stryMutAct_9fa48("1811") ? rng() / (part.max - part.min + 1) : (stryCov_9fa48("1811"), rng() * (stryMutAct_9fa48("1812") ? part.max - part.min - 1 : (stryCov_9fa48("1812"), (stryMutAct_9fa48("1813") ? part.max + part.min : (stryCov_9fa48("1813"), part.max - part.min)) + 1)))));
        for (let i = 0; stryMutAct_9fa48("1816") ? i >= count : stryMutAct_9fa48("1815") ? i <= count : stryMutAct_9fa48("1814") ? false : (stryCov_9fa48("1814", "1815", "1816"), i < count); stryMutAct_9fa48("1817") ? i-- : (stryCov_9fa48("1817"), i++)) if (stryMutAct_9fa48("1818")) {
          ;
        } else {
          stryCov_9fa48("1818");
          genAtom(rng, st, part.atom);
        }
      }
    }
  }
};

/**
 * Catastrophic-backtracking screen for the VERIFY step. `generate`
 * confirms candidates with the real `RegExp.test` — synchronous and
 * uninterruptible, so a pattern like `(a|aa)+b` tested against a
 * near-miss candidate can hang the event loop forever (exponential
 * backtracking). This walks the parsed AST and flags the classic
 * shapes: a REPEATED unit (`*`, `+`, `{n,m}` with max > 1) whose
 * subtree is ambiguous — i.e. contains an alternation or a nested
 * quantifier (`(a|aa)+`, `(a|b)*`, `(a+)+`, `(a?)+`).
 *
 * Deliberately conservative: `(cat|dog)+` is rejected even though its
 * branches are usually disjoint — telling them apart needs real
 * regex analysis, and `@ktb/seed` is dev/test tooling where a rare
 * SeedError beats a hang. Non-group atoms (`a+`, `\d*`, `[abc]+`) are
 * never flagged: a single-char/class repeat cannot branch.
 *
 * Throws {@link SeedError} on patterns the subset parser rejects —
 * callers already treat those as ungeneratable.
 */
export const patternHasUnsafeRepetition = (pattern: string): boolean => {
  if (stryMutAct_9fa48("1819")) {
    {}
  } else {
    stryCov_9fa48("1819");
    const ast = new Parser(pattern).parse();
    // Does this subtree admit ambiguous parses? An alternation, or any
    // nested quantified part, makes a repeated unit exponential.
    const nodeAmbiguous = stryMutAct_9fa48("1820") ? () => undefined : (stryCov_9fa48("1820"), (() => {
      const nodeAmbiguous = (node: Node): boolean => (stryMutAct_9fa48("1823") ? node.t !== "alt" : stryMutAct_9fa48("1822") ? false : stryMutAct_9fa48("1821") ? true : (stryCov_9fa48("1821", "1822", "1823"), node.t === (stryMutAct_9fa48("1824") ? "" : (stryCov_9fa48("1824"), "alt")))) ? stryMutAct_9fa48("1825") ? false : (stryCov_9fa48("1825"), true) : stryMutAct_9fa48("1826") ? node.parts.every(p => atomAmbiguous(p.atom) || p.min !== 1 || p.max !== 1) : (stryCov_9fa48("1826"), node.parts.some(stryMutAct_9fa48("1827") ? () => undefined : (stryCov_9fa48("1827"), p => stryMutAct_9fa48("1830") ? (atomAmbiguous(p.atom) || p.min !== 1) && p.max !== 1 : stryMutAct_9fa48("1829") ? false : stryMutAct_9fa48("1828") ? true : (stryCov_9fa48("1828", "1829", "1830"), (stryMutAct_9fa48("1832") ? atomAmbiguous(p.atom) && p.min !== 1 : stryMutAct_9fa48("1831") ? false : (stryCov_9fa48("1831", "1832"), atomAmbiguous(p.atom) || (stryMutAct_9fa48("1834") ? p.min === 1 : stryMutAct_9fa48("1833") ? false : (stryCov_9fa48("1833", "1834"), p.min !== 1)))) || (stryMutAct_9fa48("1836") ? p.max === 1 : stryMutAct_9fa48("1835") ? false : (stryCov_9fa48("1835", "1836"), p.max !== 1))))));
      return nodeAmbiguous;
    })());
    const atomAmbiguous = stryMutAct_9fa48("1837") ? () => undefined : (stryCov_9fa48("1837"), (() => {
      const atomAmbiguous = (atom: Atom): boolean => stryMutAct_9fa48("1840") ? atom.t === "group" || nodeAmbiguous(atom.node) : stryMutAct_9fa48("1839") ? false : stryMutAct_9fa48("1838") ? true : (stryCov_9fa48("1838", "1839", "1840"), (stryMutAct_9fa48("1842") ? atom.t !== "group" : stryMutAct_9fa48("1841") ? true : (stryCov_9fa48("1841", "1842"), atom.t === (stryMutAct_9fa48("1843") ? "" : (stryCov_9fa48("1843"), "group")))) && nodeAmbiguous(atom.node));
      return atomAmbiguous;
    })());
    const unsafeNode = stryMutAct_9fa48("1844") ? () => undefined : (stryCov_9fa48("1844"), (() => {
      const unsafeNode = (node: Node): boolean => (stryMutAct_9fa48("1847") ? node.t !== "alt" : stryMutAct_9fa48("1846") ? false : stryMutAct_9fa48("1845") ? true : (stryCov_9fa48("1845", "1846", "1847"), node.t === (stryMutAct_9fa48("1848") ? "" : (stryCov_9fa48("1848"), "alt")))) ? stryMutAct_9fa48("1849") ? node.options.every(unsafeNode) : (stryCov_9fa48("1849"), node.options.some(unsafeNode)) : stryMutAct_9fa48("1850") ? node.parts.every(p => p.max > 1 && atomAmbiguous(p.atom) || p.atom.t === "group" && unsafeNode(p.atom.node)) : (stryCov_9fa48("1850"), node.parts.some(stryMutAct_9fa48("1851") ? () => undefined : (stryCov_9fa48("1851"), p => stryMutAct_9fa48("1854") ? p.max > 1 && atomAmbiguous(p.atom) && p.atom.t === "group" && unsafeNode(p.atom.node) : stryMutAct_9fa48("1853") ? false : stryMutAct_9fa48("1852") ? true : (stryCov_9fa48("1852", "1853", "1854"), (stryMutAct_9fa48("1856") ? p.max > 1 || atomAmbiguous(p.atom) : stryMutAct_9fa48("1855") ? false : (stryCov_9fa48("1855", "1856"), (stryMutAct_9fa48("1859") ? p.max <= 1 : stryMutAct_9fa48("1858") ? p.max >= 1 : stryMutAct_9fa48("1857") ? true : (stryCov_9fa48("1857", "1858", "1859"), p.max > 1)) && atomAmbiguous(p.atom))) || (stryMutAct_9fa48("1861") ? p.atom.t === "group" || unsafeNode(p.atom.node) : stryMutAct_9fa48("1860") ? false : (stryCov_9fa48("1860", "1861"), (stryMutAct_9fa48("1863") ? p.atom.t !== "group" : stryMutAct_9fa48("1862") ? true : (stryCov_9fa48("1862", "1863"), p.atom.t === (stryMutAct_9fa48("1864") ? "" : (stryCov_9fa48("1864"), "group")))) && unsafeNode(p.atom.node)))))));
      return unsafeNode;
    })());
    return unsafeNode(ast);
  }
};

/**
 * Generate a string matching `pattern` (a JS regex source). `limit`
 * caps output length (typically the schema's `maxLength`, else
 * {@link MAX_PATTERN_OUTPUT}). Throws {@link SeedError} on unsupported
 * syntax or when the pattern can't be satisfied within the limit.
 */
export const generateFromPattern = (pattern: string, rng: () => number, limit = MAX_PATTERN_OUTPUT): string => {
  if (stryMutAct_9fa48("1865")) {
    {}
  } else {
    stryCov_9fa48("1865");
    if (stryMutAct_9fa48("1869") ? pattern.length <= 200 : stryMutAct_9fa48("1868") ? pattern.length >= 200 : stryMutAct_9fa48("1867") ? false : stryMutAct_9fa48("1866") ? true : (stryCov_9fa48("1866", "1867", "1868", "1869"), pattern.length > 200)) {
      if (stryMutAct_9fa48("1870")) {
        {}
      } else {
        stryCov_9fa48("1870");
        // Same bound the subset checker enforces — unreachable for valid
        // schemas, kept as defense in depth.
        throw new SeedError(stryMutAct_9fa48("1872") ? "" : (stryCov_9fa48("1872"), "pattern exceeds MAX_PATTERN_LENGTH"));
      }
    }
    const ast = new Parser(pattern).parse();
    const st: GenState = stryMutAct_9fa48("1873") ? {} : (stryCov_9fa48("1873"), {
      out: stryMutAct_9fa48("1874") ? "Stryker was here!" : (stryCov_9fa48("1874"), ""),
      limit: stryMutAct_9fa48("1875") ? Math.max(limit, MAX_PATTERN_OUTPUT * 4) : (stryCov_9fa48("1875"), Math.min(limit, stryMutAct_9fa48("1876") ? MAX_PATTERN_OUTPUT / 4 : (stryCov_9fa48("1876"), MAX_PATTERN_OUTPUT * 4)))
    });
    if (stryMutAct_9fa48("1877")) {
      ;
    } else {
      stryCov_9fa48("1877");
      genNode(rng, st, ast);
    }
    return st.out;
  }
};