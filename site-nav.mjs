// Shared top navigation. Every page is built by its own script, so the markup
// lives here rather than in the head template (which ends before <body>).

const LINKS = [
  ['/', 'Ratings'],
  ['/signals/', 'Signals'],
  ['/check/', 'Check a wallet'],
  ['/evidence/', 'Evidence'],
  ['/api/', 'API'],
];

export function nav(current) {
  const items = LINKS.map(([href, label]) =>
    `<a class="nav" href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('\n  ');
  return `<nav class="sitenav">
  <a class="brand" href="/"><img class="brandmark" src="/mark.png" srcset="/mark.png 1x, /mark@2x.png 2x" width="26" height="26" alt="">Assay Score</a>
  ${items}
</nav>`;
}
