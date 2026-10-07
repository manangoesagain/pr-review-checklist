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

## Test it

```bash
npm test
```

## How it's planned

The planning documents are in [`devpost/`](devpost): the scope, the product requirements, the technical spec and the build checklist.

## License

MIT
