// Runs inside the sandbox: launches Chromium the way the pptx skill does, and
// renders a page to prove it really works.
const { chromium } = require("/app/node_modules/playwright");

async function main() {
	const browser = await chromium.launch({ env: { TMPDIR: process.env.TMPDIR || "/tmp" } });
	const page = await browser.newPage();
	await page.setContent("<title>spike</title><h1>spike</h1>");
	const title = await page.title();
	const image = await page.screenshot();
	await browser.close();
	if (title !== "spike" || image.length === 0) throw new Error("Chromium did not render the page");
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
