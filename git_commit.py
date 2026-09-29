#!/usr/bin/env python3
import subprocess
import sys
import os

os.chdir(r"c:\Users\Nuelthewave\Desktop\swiftchain\SwiftChain_Backend")

try:
    # Add all changes
    print("Adding files...")
    subprocess.run(["git", "add", "-A"], check=True)
    
    # Commit
    print("Committing...")
    message = """feat: Add mutation testing (StrykerJS) for service layer - Issue #114

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
Initial run will establish baseline mutation score for validating test quality."""
    
    subprocess.run(["git", "commit", "-m", message], check=True)
    
    print("\n✓ Successfully committed!")
    print("\nNext steps:")
    print("  git push -u origin feature/socket-metrics-enhancements")
    print("  npm install && npm run test:mutation")
    
except subprocess.CalledProcessError as e:
    print(f"Git error: {e}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
