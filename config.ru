require "dotenv"
Dotenv.load(File.expand_path(".env", __dir__))

require "rack/unreloader"

dev = ENV["RACK_ENV"] == "development"
require_relative "lib/logger"

# Only the app's own constants are unloaded; gems required from reloadable
# files would otherwise be attributed to them and torn down on reload.
RELOADABLE = %w[Roda Sequel::Model PathGuard Listing TextView Form ModelView ShareManager LinkManager FileServer Zipper Callback McpServer].freeze
Unreloader = Rack::Unreloader.new(subclasses: RELOADABLE, reload: dev, logger: ($log if dev)) { App }
Unreloader.require(File.expand_path("app.rb", __dir__)) { "App" }

Setting.seed_defaults!
IdleSweeper.start

run(dev ? Unreloader : App.freeze.app)
