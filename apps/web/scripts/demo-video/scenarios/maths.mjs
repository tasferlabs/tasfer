// Maths-heavy demo: a short note on the Gaussian integral.
//
// Inline formulas are typed as `$…$`. Display equations are built live, one
// command at a time, so the video shows fractions, roots, limits and sums
// taking shape on the canvas.

export default async function maths(d) {
  await d.type("The Gaussian integral");
  await d.enter();

  await d.type("The bell curve ");
  await d.inlineMath("e^{-x^2}");
  await d.type(" has no elementary integral, yet the area under it is exact:");
  await d.enter();
  await d.blockMath("\\int_{-\\infty}^{\\infty} e^{-x^{2}} dx = \\sqrt{\\pi}");

  await d.type("Scale it and you get the normal distribution:");
  await d.enter();
  await d.blockMath(
    "f(x) = \\frac{1}{\\sigma \\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^{2}}{2\\sigma^{2}}}",
  );

  await d.type("The same ");
  await d.inlineMath("\\pi");
  await d.type(" turns up in a sum Euler made famous:");
  await d.enter();
  await d.blockMath(
    "\\sum_{n=1}^{\\infty} \\frac{1}{n^{2}} = \\frac{\\pi^{2}}{6}",
  );
  await d.pause(1200);
}
