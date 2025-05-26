# Contributing to NaNofuzz

<!-- toc -->

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Development](#development)
- [Contributing](#contributing)
- [Release](#release)

<!-- tocstop -->

## Prerequisites

Since NaNofuzz is a Visual Studio Code extension, we assume throughout this document that you are using Visual Studio Code as your IDE.

### Developing in Codespaces

You can use GitHub Codespaces to develop NaNofuzz.
The `nanofuzz/nanofuzz` repository is already configured for this to work without any changes.

### Developing Locally (all platforms)

Be sure you have these tools installed:

- [Git][]
- [Node.js][] v16+ (if using Linux or Mac, we recommend installing via [nvm][])
- [Yarn][] v1.x

If you're using [Nix][], all dependencies other than Git will be automatically provided by the `flake.nix` file in this repo once you've cloned it.

### Developing in Windows WSL

Here are some WSL-specific guides:

- [Guide for installing nvm and Node.js][]
- [Guide for installing Yarn][]

## Setup

Once you've installed all prerequisites, [clone][] [this repo][] in VS Code.
The rest of this document assumes you are running commands from the root directory of your repo from the terminal in VS Code, unless otherwise specified.
Next [install dependencies][]:

```sh
yarn
```

## Development

### Build

Build NaNofuzz:

```sh
yarn build
```

### Test

Test NaNofuzz:

```sh
yarn test
```

### Run

To run the local version of the NaNofuzz extension:

- Build NaNofuzz (`yarn build`)
- Press `Fn`+`F5` to open a new VS Code window running VSC's Extension Development Host. (Note that the top of the new window says `[Extension Development Host]`)
- The first time you do this, [clone]() a repo like `nanofuzz/nanofuzz-examples` so that you have some programs available for testing your changes to NaNofuzz.
  - ```sh
    git clone https://github.com/nanofuzz/nanofuzz-examples.git
    ```
- Click `File->Add folder to workspace` and select the cloned folder (e.g., `nanofuzz-examples`.
- Note: It might take a few minutes for the Extension Host to start the extension in development.
- If you cloned `nanofuzz-examples`, run `yarn` to install its dependencies.
- Click the `NaNofuzz...` button above one of the example functions to start NaNofuzz.
- Some debug info may be found in the main VSC window's debug console.
- To test a new build of NaNofuzz
  - Close the Extension Development Host VSC window
  - Stop debugging in the main VSC window where you are developing NaNofuzz
  - Repeat the process above

## Contributing

### Creating your fork

If you'd like to make a change and contribute it back to the project, but you
don't have write permissions to this repository, you'll need to [create a
fork][]. Click the **Fork** button in the top-right corner of this page.

You should already have a clone of this repo by following the instructions at
the start of this document, so now you simply need to add your fork as another
[remote][]:

```sh
git remote add fork https://github.com/<your-github-account-name>/nanofuzz.git
```

### Finding an issue to work on

Check out our list of [good first issues][].

- Before working on one of them, let us know that you are interested so we can
  give you more guidance! (Currently the issue descriptions are fairly brief.)

- Create a separate [branch][] in your forked repo to work on the issue:

  ```sh
  git switch --create <my-branch>
  git push --set-upstream fork <my-branch>
  ```

### Merging new changes from upstream

If you need to merge new changes from upstream (i.e. the original NaNofuzz repo):

```sh
git fetch origin main:main
git merge main
```

After running the above, manage any [merge conflicts][], [commit][] to your
branch, and then [push][] to your fork:

```sh
git push
```

### Adding tests

For some PRs, it can be helpful to add tests that help verify the correctness of new features, and which ensure features don't break in future versions. Tests can be added to new or existing `.test.ts` files.

### Opening a pull request (PR)

When your work is ready for review:

- [Open a pull request][] (PR) by clicking on the **Contribute** button on the
  homepage of your forked repo
  (`https://github.com/<your-github-account-name>/nanofuzz`).
- Put `fix:` or `feat:` or `chore:` at the beginning of the PR title depending on if it's a
  fix or a feature. We follow [conventional commit guidelines][].
- Document your changes and rationale in the PR's description (including link(s) to any issue(s) you address).
- Some things will be checked automatically by our [CI][]:
  - Make sure the system passes the regression tests (`yarn test`).
- If you have permission, request review from the relevant person. Otherwise, no
  worries: we'll take a look at your PR and assign it to a maintainer.
- When your PR is approved, a maintainer will merge it.

If you hit any snags in the process, run into bugs, or just have questions, please file an issue!

## Release

Our repo uses [semantic versioning][] and maintains the same version number for all packages. Generally speaking, we release new versions whenever new features are introduced (PRs with `feat` tag). Here are the steps for creating new releases.

- Make sure all PRs for the upcoming release are merged. Switch to `main` and check `git status` to make sure it's clean and up-to-date.
- Create a new version branch (`git checkout -b "vX.Y.Z"`)
- Increment the version number in `package.json` and `./packages/runtime/package.json` and ensure the versions match in both files.
- Build and run NaNofuzz tests (`yarn build` and `yarn test`)
- Build the npm runtime package (`cd packages/runtime`, `yarn build`, `cd ../..`)
- Stage commit and push to the remote branch (`git add .`, `git commit -m "chore: update version to vX.Y.Z"`, and `git push`)
- Open a new PR with title `chore: update version to vX.Y.Z` and merge after CI passes.
- Create a new GitHub tag and [GitHub release][] in the format `vX.Y.Z`.
- Push the new version to VSC Marketplace (`yarn run publish`)
- If needed, push the new npm package to npm (`cd packages/runtime`, `npm publish --access public`, `cd ../..`)
- Clone the [NaNofuzz playground](https://github.com/nanofuzz/nanofuzz-examples)
  - If needed, upgrade the `@nanofuzz/runtime` package: `yarn update @nanofuzz/runtime@X.Y.Z`
  - Ensure the version of the NaNofuzz extension loaded is the new one
  - Stage, commit, and push the updated `package.json` and `yarn.lock`
  - Make sure all the examples still work. (Note: running the examples will generate a lot of `.json` files you probably don't want to commit)

[branch]: https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging
[ci]: https://docs.github.com/en/actions
[clone]: https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository
[commit]: https://github.com/git-guides/git-commit
[conventional commit guidelines]: https://www.conventionalcommits.org/en/v1.0.0/
[create a fork]: https://docs.github.com/en/get-started/quickstart/fork-a-repo
[git]: https://git-scm.com/downloads
[good first issues]: https://github.com/nanofuzz/nanofuzz/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22
[guide for installing nvm and node.js]: https://logfetch.com/install-node-npm-wsl2/
[guide for installing yarn]: https://dev.to/bonstine/installing-yarn-on-wsl-38p2
[homebrew]: https://brew.sh/
[install dependencies]: https://classic.yarnpkg.com/en/docs/installing-dependencies
[merge conflicts]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-using-the-command-line
[nix]: https://nixos.org/
[node.js]: https://nodejs.org/en/download/
[npm]: https://www.npmjs.com/
[nvm]: https://github.com/nvm-sh/nvm
[open a pull request]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request
[prettier]: https://prettier.io/
[push]: https://github.com/git-guides/git-push
[remote]: https://git-scm.com/book/en/v2/Git-Basics-Working-with-Remotes
[this repo]: https://github.com/nanofuzz/nanofuzz
[yarn]: https://classic.yarnpkg.com/lang/en/docs/install/
[semantic versioning]: https://semver.org
[github release]: https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository
