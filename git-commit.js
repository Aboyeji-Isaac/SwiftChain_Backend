const { execSync } = require('child_process');
const path = require('path');

const repoPath = r'c:\Users\Nuelthewave\Desktop\swiftchain\SwiftChain_Backend';
process.chdir(repoPath);

try {
  console.log('Adding files...');
  execSync('git add -A', { stdio: 'inherit' });
  
  console.log('Committing...');
  const message = `feat: Add mutation testing (StrykerJS) for service layer - Issue #114

- Create stryker.conf.json with service-layer-only mutation scope (src/services/**)
- Configure Jest runner with TypeScript checker plugin
- Set achievable break threshold at 60% baseline
- Add test:mutation npm script for mutation test execution
- Update .gitignore to exclude Stryker artifacts (.stryker-tmp, reports/)
- Include comprehensive documentation:
  * MUTATION_TESTING_SETUP.md: detailed implementation and guidance
  * MUTATION_TESTING_PR.md: PR description with expected results

All 24 services in src/services/ are covered for mutation testing.
No application code changes; tooling/config addition only.
Initial run will establish baseline mutation score for validating test quality.`;
  
  execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  
  console.log('\n✓ Successfully committed!');
  console.log('\nNext steps:');
  console.log('  git push -u origin feature/socket-metrics-enhancements');
  console.log('  npm install && npm run test:mutation');
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
