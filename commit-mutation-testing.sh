#!/bin/bash

# Commit script for Mutation Testing implementation (Issue #114)

echo "Staging mutation testing files..."
git add stryker.conf.json package.json .gitignore MUTATION_TESTING_SETUP.md MUTATION_TESTING_PR.md

echo "Committing changes..."
git commit -m "feat: Add mutation testing (StrykerJS) for service layer validation (Issue #114)

- Create stryker.conf.json with Service-layer-only mutation scope (src/services/**)
- Configure Jest runner integration with TypeScript type checker plugin
- Set break threshold at 60% (achievable baseline for iterative improvement)
- Add test:mutation npm script for running mutation tests
- Update .gitignore to exclude Stryker artifacts (.stryker-tmp, reports/)
- Include comprehensive documentation:
  * MUTATION_TESTING_SETUP.md: detailed implementation guide
  * MUTATION_TESTING_PR.md: PR description with expected results and follow-up guidance

All 24 services covered for mutation testing. No application code changes.
Initial run will establish baseline mutation score for test quality validation."

echo "Complete! Branch ready to push."
echo ""
echo "Next steps:"
echo "  git push -u origin feature/socket-metrics-enhancements"
echo "  npm install && npm run test:mutation"
