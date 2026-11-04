// a page that sends the cases of ?do= (comma separated) to the background by runtime.sendMessage, one
// after another, and reports what each one got back - the answer, or the message of the error - by a
// separate runtime.sendMessage({report}); round-39
const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';
const cases = (params.get('do') ?? '').split(',').filter(Boolean);

document.title = name;
document.getElementById('name').textContent = name;

const report = detail => browser.runtime.sendMessage({report: name, ...detail}).catch(() => {});

for (const ask of cases) {
    try {
        const answer = await browser.runtime.sendMessage({ask});

        await report({case: ask, answer: answer === undefined ? 'undefined' : JSON.stringify(answer)});
    } catch (error) {
        await report({case: ask, error: error.message});
    }
}
