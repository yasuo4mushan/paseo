{
  description = "aaswitch - self-hosted daemon for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          aaswitch = pkgs.callPackage ./nix/package.nix { };
          versionParts = pkgs.lib.splitString "." aaswitch.version;
          sourceRevision = if self ? revCount && self.revCount != null then self.revCount else 0;
          buildRevision = sourceRevision - (sourceRevision / 10000) * 10000;
          desktopBuildVersion = pkgs.lib.concatStringsSep "." [
            (builtins.elemAt versionParts 0)
            (builtins.elemAt versionParts 1)
            (toString buildRevision)
          ];
        in
        {
          default = aaswitch;
          aaswitch = aaswitch;
          desktop = pkgs.callPackage ./nix/desktop-package.nix {
            aaswitch = aaswitch;
            buildVersion = desktopBuildVersion;
          };
        }
      );

      nixosModules.default = self.nixosModules.aaswitch;
      nixosModules.aaswitch =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.aaswitch.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.python3
            ];
          };
        }
      );
    };
}
