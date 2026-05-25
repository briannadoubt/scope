class Scope < Formula
  desc "Local-first kanban for projects, epics, stories, and bugs — CLI + web UI + MCP"
  homepage "https://github.com/briannadoubt/scope"
  url "https://registry.npmjs.org/scope-kanban/-/scope-kanban-0.1.0.tgz"
  sha256 "REPLACE_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
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
