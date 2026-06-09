class Scope < Formula
  desc "Local-first kanban for projects, epics, stories, and bugs — CLI + web UI"
  homepage "https://github.com/briannadoubt/scope"
  url "https://github.com/briannadoubt/scope/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_AFTER_FIRST_RELEASE"
  license "MIT"
  head "https://github.com/briannadoubt/scope.git", branch: "main"

  # Pin to LTS so prebuilt better-sqlite3 binaries are available. Latest "node"
  # tracks the active branch (currently 26.x), which native modules lag behind.
  depends_on "node@22"

  def install
    # Install runtime dependencies in-place. --omit=dev keeps the install small;
    # there are no devDeps but the flag also future-proofs.
    system "npm", "ci", "--omit=dev", "--no-audit", "--no-fund"

    # Ship the whole tree (bin/, src/, node_modules/, package.json, LICENSE)
    libexec.install Dir["*"]

    # Expose the CLI on PATH
    (bin/"scope").write <<~SH
      #!/bin/bash
      exec "#{Formula["node@22"].opt_bin}/node" "#{libexec}/bin/scope.js" "$@"
    SH
    chmod 0755, bin/"scope"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/scope --version")

    # round-trip: init, create project, list projects as JSON, expect KEY
    mkdir_p testpath/"app"
    cd testpath/"app" do
      system bin/"scope", "init"
      system bin/"scope", "project", "create", "demo", "DEMO", "Demo project"
      output = shell_output("#{bin}/scope --json project list")
      assert_match "\"key\": \"DEMO\"", output
    end
  end
end
