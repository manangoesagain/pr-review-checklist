# PR Review Checklist

Paste a GitHub pull request link and get the checklist a careful senior reviewer would run: security, tests, breaking changes, docs and performance, with every item pointing at the exact line of code it is about. Built for beginners reviewing someone else's PR and solo developers checking their own.

> Work in progress for the Devpost "Build With AI: Basics" hackathon. "PR Review Checklist" is a working name.

## Run it

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000 and paste the link of any public GitHub pull request, click **Try a sample**, or paste a diff from `git diff`.

GitHub lets you read about 20 PRs an hour without signing in (each review makes about three requests, and a repeat within 10 minutes is free). For more, add a `GITHUB_TOKEN` to `.env`.

Without an AI key the app runs in **basic mode**: counted facts and pattern checks only. To turn on the AI reviewer, copy `.env.example` to `.env` and paste a free key from [build.nvidia.com](https://build.nvidia.com).

NVIDIA retires models every few months. At startup the app sends the model one tiny request, and if it doesn't answer, the app tries the usual replacements your key can use and tells you which one it picked.

## Test it

```bash
npm test
```

## The demo repo

**Try a sample** reviews a small bookshop API whose pull request has five planted problems: SQL built from search text, no tests, a changed response shape, a new endpoint missing from the README, and a query inside a loop. A second, clean pull request has none. To put the demo on your own GitHub so its links open:

1. Create an empty public repo called `bookshop-demo` (no README, no license).
2. Build the demo repo and push its three branches:

   ```bash
   node demo/build-demo.js ../bookshop-demo
   cd ../bookshop-demo
   git remote add origin https://github.com/YOUR-NAME/bookshop-demo.git
   git push -u origin main order-search isbn-lookup
   ```

3. On GitHub, open two pull requests into `main`, in this order, and leave them open: `order-search` titled "Add order search" (#1), then `isbn-lookup` titled "Look up a book by ISBN" (#2).

The commits come out identical on every computer, so the saved samples match the real PRs. `node demo/build-demo.js --check` confirms it. If you use a different account, change `DEMO_REPO` in `demo/build-demo.js` and run `npm run samples`.

## Measure it

The evaluation runs the AI reviewer several times on both demo PRs and prints a score: planted problems found, false alarms on the clean PR, and how many AI suggestions each check hid.

```bash
node eval/run-eval.js --runs 10
node eval/run-eval.js --list
node eval/run-eval.js --model FIRST-MODEL,SECOND-MODEL
node eval/run-eval.js --fake
```

`--list` prints the chat models your key can use. `--model` compares models side by side: copy names from that list, separated by a comma. `--real` also reviews the public PRs listed in `eval/real-prs.json`, for you to judge by eye. `--fake` uses saved AI replies, so it runs without a key.

## How it's planned

The planning documents are in [`devpost/`](devpost): the scope, the product requirements, the technical spec and the build checklist.

## License

MIT
