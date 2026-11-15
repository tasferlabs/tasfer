// Two peers on one page, seen from Alice's screen. Alice asks about a right
// triangle, Bob answers with Pythagoras, then Alice adds its area. They take
// turns.
//
// Bob shows up as a named caret, and his text arrives as he types it. Alice
// builds her last formulas with the LaTeX menu that opens on `\`.

export const peers = ["Alice", "Bob"];

export default async function peersMaths({ alice, bob }) {
  // Both carets start in the title; Alice writes it.
  await alice.type("The right triangle");
  await alice.enter();
  await alice.type("A right triangle has two short sides ");
  await alice.inlineMath("a");
  await alice.type(" and ");
  await alice.inlineMath("b");
  await alice.type(". Bob, how long is the long side ");
  await alice.inlineMath("c");
  await alice.type("?");
  await alice.pause(900);

  // Bob takes it from the end of the page.
  await bob.press("Meta+ArrowDown");
  await bob.enter();
  await bob.blockMath("c = \\sqrt{a^{2}+b^{2}}");
  await bob.type("So sides 3 and 4 give ");
  await bob.inlineMath("c = \\sqrt{9+16} = 5");
  await bob.type(".");
  await bob.pause(700);

  // Alice adds the area at the bottom.
  await alice.press("Meta+ArrowDown");
  await alice.enter();
  await alice.type("And its area is half of a times b: ");
  await alice.inlineMath("A");
  await alice.editMath(async () => {
    await alice.math("=");
    await alice.command("fr", "frac");
    await alice.math("ab");
    await alice.press("Tab");
    await alice.math("2");
    await alice.press("Tab");
  });
  await alice.type(", so here ");
  await alice.inlineMath("A");
  await alice.editMath(async () => {
    await alice.math("=");
    await alice.command("fr", "frac");
    await alice.math("12");
    await alice.press("Tab");
    await alice.math("2");
    await alice.press("Tab");
    await alice.math("=6");
  });
  await alice.type(".");
  await alice.pause(1500);
}
