# Testing

Fork https://github.com/SpecDriven/specs-insurance and 'git clone' locally in order to have write permissions.

# Development

## Clone the spec repo

This app's own specs live in a separate repo, [SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
and `specs/` here is a checked-in symlink to `../specs-specdriven`. Clone it as a
sibling of this checkout, or `specs/` dangles:

```sh
gh repo clone SpecDriven/specs-specdriven ../specs-specdriven
```

Without `gh`, `git clone https://github.com/SpecDriven/specs-specdriven.git ../specs-specdriven`
does the same. Nothing at runtime reads `specs/` — it is there for the workflow
below — so a dangling symlink breaks neither the build nor the tests, only the
links in this README and the spec references in the code.
