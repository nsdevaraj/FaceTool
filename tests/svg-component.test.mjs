import test from "node:test";
import assert from "node:assert/strict";
import * as component from "../lib/svgeditor.js";

test("simple path validation keeps editable curves and rejects malformed/lossy geometry", () => {
  for (const d of ["M0 0 L10 20 Z", "m0 0 1 2 c1 2 3 4 5 6", "M1e2 -.3 H4 V5 Q1 2 3 4 T5 6", "M0 0 C1 2 3 4 5 6 S7 8 9 10"]) {
    assert.equal(component.validateSimplePath(d), d);
  }
  for (const d of ["", "L0 0", "M0", "M0 0 L1", "M0 0 Z1", "M0 0 A2 3 45 0 0 4 5", "M0,,0", "M0 0 junk", "M0 0 L1e999 2"]) {
    assert.throws(() => component.validateSimplePath(d), Error, d);
  }
});

test("built-in face and hand axis-aligned arcs remain editable without rewriting geometry", () => {
  const d = "M67 80 A13 13 0 1 0 93 80 A13 13 0 1 0 67 80 Z";
  const shape = { type:"rawpath", d, tx:0, ty:0, fill:"#abc", stroke:"none", sw:0 };
  assert.equal(component.validateSimpleShapes([shape])[0].d, d);
  for (const bad of ["M0 0 A-2 3 0 0 1 4 5", "M0 0 A2 3 0 2 1 4 5", "M0 0 A2 3 1 0 1 4 5"]) {
    assert.throws(() => component.validateSimplePath(bad));
  }
});

test("portable shape validation accepts neutral style defaults without changing records", () => {
  const records = [
    { type:"rawpath", d:"M0 0 L1 2", tx:0, ty:0, fill:"none", stroke:"#ABC", sw:0 },
    { type:"ellipse", cx:0, cy:0, rx:4, ry:3, fill:"#abcdef", stroke:"none", sw:1 },
    { type:"rect", x:0, y:1, w:4, h:3, fill:"#abc", stroke:"#000", sw:2, rotation:0,
      linecap:"round", linejoin:"round", miterlimit:4, dasharray:[], dashoffset:0 },
    { type:"path", pts:[{x:0,y:0},{x:1,y:2}], closed:false, fill:"none", stroke:"#000000", sw:1 },
  ];
  assert.equal(component.validateSimpleShapes(records), records);
});

test("portable shape validation rejects unsupported styles and non-finite geometry", () => {
  const rect = { type:"rect", x:0, y:0, w:4, h:3, fill:"#abc", stroke:"#000", sw:2 };
  for (const change of [
    { type:"text" }, { gradient:{} }, { rotation:5 }, { rotation:NaN },
    { linecap:"butt" }, { linejoin:"bevel" }, { miterlimit:8 }, { dasharray:[2,1] },
    { dasharray:"6 3" }, { dashoffset:1 }, { fill:"url(#paint)" }, { fill:"#12345" },
    { fill:"#1234" }, { fill:"#abcdef80" },
    { stroke:"red" }, { x:Infinity }, { w:-1 }, { sw:NaN }, { sw:-1 },
  ]) assert.throws(() => component.validateSimpleShapes([{ ...rect, ...change }]), Error);
});

test("shared geometry helpers remain exported by the component", () => {
  for (const name of ["createSvgEditor", "rn", "xmlAttr", "deepCloneShapes", "buildPathD",
    "regularPolygonPoints", "starPoints", "arrowPoints", "spiralPoints", "gridPathD",
    "ellipsePathD", "normHex6", "normColor", "normalizeDasharray", "strokeAttributes",
    "bboxShape", "unionBBoxes", "alignBBoxes", "distributeBBoxes"]) {
    assert.equal(typeof component[name], "function", name);
  }
});
