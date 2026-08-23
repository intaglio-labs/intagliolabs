import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPeopleByAsset, peopleMeta, peopleText, personNames } from '../lib/peopleRows.mjs';

const names = personNames([
  { Z_PK: 1, ZFULLNAME: 'Sarah Chen' },
  { Z_PK: 2, ZFULLNAME: '  Mike  ' },
  { Z_PK: 3, ZFULLNAME: '' },
  { Z_PK: 0, ZFULLNAME: 'bad pk' },
]);

test('only names the owner actually typed become names', () => {
  assert.equal(names.get(1), 'Sarah Chen');
  assert.equal(names.get(2), 'Mike', 'trimmed');
  assert.equal(names.has(3), false, 'an empty name is not a name');
  assert.equal(names.has(0), false, 'pk 0 is not a person');
});

// A portrait with several detections of one face is not a group shot.
test('repeated detections of one person count once', () => {
  const g = groupPeopleByAsset(
    [
      { ZASSETFORFACE: 10, ZPERSONFORFACE: 1 },
      { ZASSETFORFACE: 10, ZPERSONFORFACE: 1 },
      { ZASSETFORFACE: 10, ZPERSONFORFACE: 2 },
    ],
    { names }
  );
  assert.deepEqual(peopleMeta(g.get(10)).people, [1, 2]);
});

// "Three people, one I can't identify" is true and useful — but an
// unclustered face is not an identity and gets no id.
test('unclustered faces are counted, never given an identity', () => {
  const g = groupPeopleByAsset(
    [
      { ZASSETFORFACE: 11, ZPERSONFORFACE: 1 },
      { ZASSETFORFACE: 11, ZPERSONFORFACE: null },
      { ZASSETFORFACE: 11, ZPERSONFORFACE: null },
    ],
    { names }
  );
  const m = peopleMeta(g.get(11));
  assert.deepEqual(m.people, [1]);
  assert.equal(m.faces_unidentified, 2);
});

test('an unnamed cluster keeps its id and invents no name', () => {
  const g = groupPeopleByAsset([{ ZASSETFORFACE: 12, ZPERSONFORFACE: 4021 }], { names });
  const m = peopleMeta(g.get(12));
  assert.deepEqual(m.people, [4021]);
  assert.equal(m.people_named, undefined, 'no "Unknown 4021", no "Person A"');
});

// A re-scan must not look like an edit to hermes' content hash.
test('output order is stable regardless of detection order', () => {
  const a = groupPeopleByAsset(
    [{ ZASSETFORFACE: 13, ZPERSONFORFACE: 2 }, { ZASSETFORFACE: 13, ZPERSONFORFACE: 1 }],
    { names }
  );
  const b = groupPeopleByAsset(
    [{ ZASSETFORFACE: 13, ZPERSONFORFACE: 1 }, { ZASSETFORFACE: 13, ZPERSONFORFACE: 2 }],
    { names }
  );
  assert.deepEqual(peopleMeta(a.get(13)), peopleMeta(b.get(13)));
  assert.equal(peopleText(a.get(13)), peopleText(b.get(13)));
});

// Names must be searchable, not buried in a JSON column.
test('named people become searchable text', () => {
  const g = groupPeopleByAsset(
    [{ ZASSETFORFACE: 14, ZPERSONFORFACE: 1 }, { ZASSETFORFACE: 14, ZPERSONFORFACE: 2 }],
    { names }
  );
  assert.equal(peopleText(g.get(14)), 'with Mike, Sarah Chen');
  // Nothing to say when nobody is named.
  const anon = groupPeopleByAsset([{ ZASSETFORFACE: 15, ZPERSONFORFACE: 999 }], { names });
  assert.equal(peopleText(anon.get(15)), '');
});

test('a photo with no faces gets no people meta at all', () => {
  assert.deepEqual(peopleMeta(undefined), {});
  assert.deepEqual(peopleMeta(groupPeopleByAsset([]).get(1)), {});
});

// THE BOUNDARY. Apple offers age/gender/ethnicity/hair/expression/gaze on
// every detection; none of it may reach a row.
test('no inferred attribute ever appears in the output', () => {
  const g = groupPeopleByAsset(
    [
      {
        ZASSETFORFACE: 16,
        ZPERSONFORFACE: 1,
        ZAGETYPE: 4,
        ZGENDERTYPE: 2,
        ZETHNICITYTYPE: 3,
        ZHAIRCOLORTYPE: 5,
        ZFACEEXPRESSIONTYPE: 2,
        ZGAZETYPE: 1,
      },
    ],
    { names }
  );
  const json = JSON.stringify(peopleMeta(g.get(16)));
  for (const k of ['age', 'gender', 'ethnic', 'hair', 'expression', 'gaze', 'inferred']) {
    assert.ok(!json.toLowerCase().includes(k), `${k} must not survive into a row: ${json}`);
  }
});
