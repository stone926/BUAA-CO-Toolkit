function normalizeWord(token) {
  return token.toUpperCase().replace(/^0X/, '').padStart(8, '0').slice(-8);
}

function sortedObject(map, compare) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => compare(left, right)));
}

function sortedRegisters(values) {
  return [...values].sort((left, right) => Number(left) - Number(right));
}

function sortedAddresses(values) {
  return [...values].map(normalizeWord).sort();
}

export function normalizedState(state) {
  return {
    gpr: sortedObject(state.gpr, (left, right) => Number(left) - Number(right)),
    dm: sortedObject(state.dm, (left, right) => left.localeCompare(right))
  };
}

export function normalizedWrites(state) {
  return {
    gpr: sortedRegisters(state.writtenGpr),
    dm: sortedAddresses(state.writtenDm)
  };
}

function compareSets(label, expectedValues, actualValues, normalize, mismatches) {
  const expected = [...new Set(expectedValues.map(normalize))].sort();
  const actual = [...new Set(actualValues.map(normalize))].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    mismatches.push(`${label} writes: expected [${expected.join(', ')}], got [${actual.join(', ')}]`);
  }
}

/** Compare declared final observations and reject every undeclared architectural write. */
export function compareExpected(expected, state) {
  const mismatches = [];
  for (const [register, value] of Object.entries(expected.gpr)) {
    const actual = state.gpr.get(register) ?? '00000000';
    if (actual !== normalizeWord(value)) {
      mismatches.push(`$gpr[${register}]: expected ${normalizeWord(value)}, got ${actual}`);
    }
  }
  for (const [address, value] of Object.entries(expected.dm)) {
    const normalizedAddress = normalizeWord(address);
    const actual = state.dm.get(normalizedAddress);
    if (actual !== normalizeWord(value)) {
      mismatches.push(`$dm[${normalizedAddress}]: expected ${normalizeWord(value)}, got ${actual ?? 'unwritten'}`);
    }
  }
  compareSets('$gpr', expected.writes.gpr, [...state.writtenGpr], String, mismatches);
  compareSets('$dm', expected.writes.dm, [...state.writtenDm], normalizeWord, mismatches);
  return mismatches;
}

export function sameNormalizedState(expectedState, expectedWrites, actualState) {
  const normalized = normalizedState(actualState);
  const writes = normalizedWrites(actualState);
  return {
    matches: JSON.stringify(expectedState) === JSON.stringify(normalized) && JSON.stringify(expectedWrites) === JSON.stringify(writes),
    normalized,
    writes
  };
}
