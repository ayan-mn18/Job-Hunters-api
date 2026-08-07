/**
 * Two HTML templates rendered from the same ResumeDocument.
 *
 *  - `ats`    : the layout we are recommending. Single column, semantic block
 *               order, standard section headings, no tables, no absolutely
 *               positioned boxes, no glyph icons, no page header/footer.
 *  - `pretty` : the control. Two-column CSS grid with a skills sidebar, a
 *               <table> for experience, a fixed page header carrying contact
 *               details, and icon glyphs. This is what most "designer" resume
 *               templates look like.
 *
 * Both are printed by the same headless Chrome, so any difference in the
 * extracted text is caused by layout alone.
 */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function fmtDate(iso) {
  if (!iso) return 'Present'
  const [y, m] = iso.split('-')
  return `${MONTHS[Number(m) - 1]} ${y}`
}

function range(start, end) {
  return `${fmtDate(start)} – ${fmtDate(end)}`
}

/* ------------------------------------------------------------------ ats -- */

export function renderAts(doc) {
  const b = doc.basics
  const contact = [
    b.email,
    b.phone,
    `${b.location.city}, ${b.location.country}`,
    ...b.links.map((l) => l.url.replace(/^https?:\/\//, '')),
  ].join(' | ')

  const experience = doc.experience
    .map(
      (job) => `
      <section class="entry">
        <p class="entry-title">${esc(job.role)}, ${esc(job.company)}</p>
        <p class="entry-meta">${esc(range(job.startDate, job.endDate))} | ${esc(job.location)}</p>
        <ul>
          ${job.bullets.map((x) => `<li>${esc(x.text)}</li>`).join('\n          ')}
        </ul>
      </section>`,
    )
    .join('\n')

  const education = doc.education
    .map(
      (ed) => `
      <section class="entry">
        <p class="entry-title">${esc(ed.credential)}, ${esc(ed.institution)}</p>
        <p class="entry-meta">${esc(range(ed.startDate, ed.endDate))}${ed.detail ? ` | ${esc(ed.detail)}` : ''}</p>
      </section>`,
    )
    .join('\n')

  const projects = doc.projects
    .map(
      (p) => `
      <section class="entry">
        <p class="entry-title">${esc(p.name)}</p>
        <p>${esc(p.description)}</p>
      </section>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(b.fullName)} — Resume</title>
<style>
  @page { size: A4; margin: 14mm 15mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.38;
    color: #000;
    margin: 0;
  }
  h1 { font-size: 18pt; margin: 0 0 2mm; letter-spacing: 0.2px; }
  h2 {
    font-size: 11pt;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin: 6mm 0 2mm;
    padding-bottom: 1mm;
    border-bottom: 0.6pt solid #000;
  }
  p { margin: 0 0 1mm; }
  ul { margin: 1mm 0 0; padding-left: 5mm; }
  li { margin-bottom: 1mm; }
  .headline { font-size: 11pt; margin-bottom: 1.5mm; }
  .contact { font-size: 9.5pt; }
  .entry { margin-bottom: 3.5mm; }
  .entry-title { font-weight: 700; }
  .entry-meta { font-size: 9.5pt; }
  .skills { margin: 0; }
</style>
</head>
<body>
  <h1>${esc(b.fullName)}</h1>
  <p class="headline">${esc(b.headline)}</p>
  <p class="contact">${esc(contact)}</p>

  <h2>Summary</h2>
  <p>${esc(doc.summary.text)}</p>

  <h2>Skills</h2>
  <p class="skills">${esc(doc.skills.map((s) => s.name).join(', '))}</p>

  <h2>Experience</h2>
${experience}

  <h2>Projects</h2>
${projects}

  <h2>Education</h2>
${education}
</body>
</html>`
}

/* --------------------------------------------------------------- pretty -- */

export function renderPretty(doc) {
  const b = doc.basics

  const experienceRows = doc.experience
    .map(
      (job) => `
        <tr>
          <td class="when">${esc(range(job.startDate, job.endDate))}</td>
          <td>
            <p class="role">${esc(job.role)}</p>
            <p class="co">${esc(job.company)} &middot; ${esc(job.location)}</p>
            <ul>${job.bullets.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>
          </td>
        </tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(b.fullName)} — Resume</title>
<style>
  @page { size: A4; margin: 0; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 10pt; margin: 0; color: #14202e; }
  .page { position: relative; width: 210mm; min-height: 297mm; padding: 26mm 14mm 18mm; }
  /* fixed page header carrying the contact block */
  .runner {
    position: fixed; top: 0; left: 0; right: 0; height: 22mm;
    background: #14202e; color: #fff; padding: 5mm 14mm;
    display: flex; justify-content: space-between; align-items: center;
  }
  .runner .who { font-size: 15pt; font-weight: 700; }
  .runner .how { font-size: 8.5pt; text-align: right; line-height: 1.5; }
  .grid { display: grid; grid-template-columns: 58mm 1fr; gap: 10mm; }
  aside h3, main h3 {
    font-size: 9.5pt; letter-spacing: 1.4px; text-transform: uppercase;
    color: #7a6a55; margin: 0 0 2mm;
  }
  aside section { margin-bottom: 7mm; }
  aside li { list-style: none; margin: 0 0 1.2mm; }
  aside ul { padding: 0; margin: 0; }
  main table { border-collapse: collapse; width: 100%; }
  main td { vertical-align: top; padding: 0 0 5mm; }
  td.when { width: 34mm; font-size: 8.5pt; color: #7a6a55; padding-right: 4mm; }
  .role { font-weight: 700; margin: 0; }
  .co { margin: 0 0 1.5mm; font-size: 9pt; color: #55606e; }
  main ul { margin: 0; padding-left: 4.5mm; }
  main li { margin-bottom: 1.2mm; }
  .icon::before { content: "\\25CF  "; color: #b08d57; }
</style>
</head>
<body>
  <div class="runner">
    <div class="who">${esc(b.fullName)}</div>
    <div class="how">
      ${esc(b.email)}<br>${esc(b.phone)}<br>${esc(b.location.city)}, ${esc(b.location.country)}
    </div>
  </div>
  <div class="page">
    <div class="grid">
      <aside>
        <section>
          <h3>Profile</h3>
          <p>${esc(doc.summary.text)}</p>
        </section>
        <section>
          <h3>Core Skills</h3>
          <ul>${doc.skills.map((s) => `<li class="icon">${esc(s.name)}</li>`).join('')}</ul>
        </section>
        <section>
          <h3>Education</h3>
          ${doc.education
            .map(
              (ed) =>
                `<p><strong>${esc(ed.credential)}</strong><br>${esc(ed.institution)}<br>${esc(range(ed.startDate, ed.endDate))}</p>`,
            )
            .join('')}
        </section>
        <section>
          <h3>Links</h3>
          <ul>${b.links.map((l) => `<li class="icon">${esc(l.url.replace(/^https?:\/\//, ''))}</li>`).join('')}</ul>
        </section>
      </aside>
      <main>
        <h3>Professional Journey</h3>
        <table>${experienceRows}</table>
        <h3>Selected Work</h3>
        ${doc.projects.map((p) => `<p><strong>${esc(p.name)}</strong> — ${esc(p.description)}</p>`).join('')}
      </main>
    </div>
  </div>
</body>
</html>`
}

export const TEMPLATES = { ats: renderAts, pretty: renderPretty }
