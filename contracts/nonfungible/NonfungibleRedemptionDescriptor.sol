// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "base64-sol/base64.sol";

import "../interfaces/IFundV3.sol";
import "../utils/HexString.sol";

contract NonfungibleRedemptionDescriptor {
    using Strings for uint256;
    using HexStrings for uint256;

    struct SVGParams {
        uint256 tokenId;
        uint256 amount;
        bool animated;
        bool claimable;
        string[] randomStrings;
    }

    function tokenURI(
        uint256 amountQ,
        uint256 seed,
        bool claimable,
        address fund,
        string memory name,
        uint256 tokenId
    ) external view returns (string memory) {
        bool animated = seed % 100 < 10; // 10% chance of being animated
        uint256[] memory randomNumbers = _unrollRandomNumbers(seed, 32);
        string[] memory randomStrings = new string[](randomNumbers.length);
        for (uint256 i = 0; i < randomNumbers.length; i++) {
            if (animated)
                randomStrings[i] = string(
                    abi.encodePacked("-", (randomNumbers[i] % 10).toString())
                ); // [-9, -0]
            else
                randomStrings[i] = string(
                    abi.encodePacked("0.", ((randomNumbers[i] % 9) + 1).toString())
                ); // [0.1, 0.9]
        }

        SVGParams memory params =
            SVGParams({
                tokenId: tokenId,
                amount: amountQ,
                animated: animated,
                claimable: claimable,
                randomStrings: randomStrings
            });

        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(
                        bytes(
                            abi.encodePacked(
                                '{"name":"',
                                _generateName(ERC20(IFundV3(fund).tokenUnderlying()).symbol()),
                                '", "description":"',
                                _generateDescription(
                                    _escapeQuotes(name),
                                    _addressToString(msg.sender)
                                ),
                                '", "image": "',
                                "data:image/svg+xml;base64,",
                                Base64.encode(bytes(_generateSVG(params))),
                                '"}'
                            )
                        )
                    )
                )
            );
    }

    /// @dev Generates a random number between 0 and 2^256 - 1.
    ///      EIP-4399 suggested a better way to generate random numbers, but its availablity is limited to ETH for now.
    ///      Admittedly this is far from generating a truly random number, but it's good enough for our purposes.
    /// @return randomNumber The random number.
    function generateRandomNumber(uint256 tokenId, uint256 amountQ)
        public
        view
        returns (uint256 randomNumber)
    {
        randomNumber = uint256(
            keccak256(
                abi.encodePacked(
                    block.coinbase,
                    block.difficulty,
                    block.timestamp,
                    blockhash(block.number - 1),
                    tokenId,
                    amountQ
                )
            )
        );
    }

    function _unrollRandomNumbers(uint256 seed, uint256 size)
        private
        pure
        returns (uint256[] memory randomNumbers)
    {
        randomNumbers = new uint256[](size);
        randomNumbers[0] = uint256(keccak256(abi.encodePacked(seed)));
        for (uint256 i = 1; i < size; i++) {
            randomNumbers[i] = uint256(keccak256(abi.encodePacked(randomNumbers[i - 1])));
        }
    }

    function _generateName(string memory symbol) private pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    "Tranchess - ",
                    " - ",
                    _escapeQuotes(symbol),
                    " - ",
                    "Redemption Request"
                )
            );
    }

    function _generateDescription(string memory symbol, string memory primaryMarketAddress)
        private
        pure
        returns (string memory)
    {
        return
            string(
                abi.encodePacked(
                    "This NFT represents a redemption request in the Tranchess ",
                    symbol,
                    " primary market. ",
                    "The owner of this NFT can claim the redemption.\\n",
                    "\\nPrimary Market Address: ",
                    primaryMarketAddress
                )
            );
    }

    function _generateSVG(SVGParams memory params) private pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    '<svg width="1000" height="1000" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg" font-family="Tahoma, sans-serif">',
                    _generateSVGDefs(),
                    abi.encodePacked(
                        "<g>",
                        '<rect width="1000" height="1000" fill="black" />',
                        '<g filter="url(#filter-1)">',
                        '<ellipse cx="-69.5" cy="585.5" rx="647.5" ry="646.5" fill="#8968B4" />',
                        "</g>",
                        '<g filter="url(#filter-2)">',
                        '<ellipse cx="801" cy="1000" rx="415" ry="414" fill="#4956B7" />',
                        "</g>",
                        '<g filter="url(#filter-3)">',
                        '<ellipse cx="1059" cy="-35" rx="696" ry="695" fill="#8AA0EE" />',
                        "</g>",
                        "</g>"
                    ),
                    _generateChessboard(params),
                    '<g style="mix-blend-mode:screen" fill="white" letter-spacing="0em">',
                    '<text x="60" y="86.6821" opacity="0.5" font-size="30">Unstaked qETH</text>',
                    '<text x="60" y="188.95" mask="url(#fade-symbol)" font-size="100" font-weight="bold">3.141592653589793238</text>',
                    _generateClaimable(params),
                    '<path fill-rule="evenodd" clip-rule="evenodd"',
                    ' d="M275.931 933.914C278.73 935.405 281.85 936.15 285.292 936.15C288.219 936.15 290.873 935.632 293.253 934.594C295.633 933.557 297.628 932.05 299.236 930.073L294.218 925.405C291.934 928.096 289.104 929.441 285.726 929.441C283.635 929.441 281.77 928.987 280.129 928.079C278.489 927.14 277.202 925.843 276.269 924.19C275.368 922.537 274.918 920.657 274.918 918.55C274.918 916.443 275.368 914.563 276.269 912.91C277.202 911.257 278.489 909.977 280.129 909.07C281.77 908.13 283.635 907.66 285.726 907.66C289.104 907.66 291.934 908.988 294.218 911.646L299.236 906.979C297.628 905.034 295.633 903.543 293.253 902.506C290.905 901.469 288.267 900.95 285.34 900.95C281.866 900.95 278.73 901.712 275.931 903.235C273.165 904.726 270.977 906.817 269.369 909.507C267.793 912.165 267.005 915.179 267.005 918.55C267.005 921.921 267.793 924.952 269.369 927.642C270.977 930.3 273.165 932.39 275.931 933.914ZM125.258 907.951H114.45V901.534H143.883V907.951H133.074V935.567H125.258V907.951ZM165.506 926.086L172.02 935.567H180.416L172.84 924.628C175.06 923.655 176.765 922.261 177.955 920.446C179.177 918.599 179.788 916.411 179.788 913.883C179.788 911.355 179.193 909.167 178.003 907.319C176.813 905.472 175.108 904.046 172.889 903.041C170.701 902.036 168.112 901.534 165.12 901.534H150.501V935.567H158.317V926.086H165.12H165.506ZM170.042 909.507C171.264 910.512 171.875 911.97 171.875 913.883C171.875 915.763 171.264 917.221 170.042 918.258C168.82 919.296 167.034 919.814 164.686 919.814H158.317V907.951H164.686C167.034 907.951 168.82 908.47 170.042 909.507ZM210.637 928.274H194.956L191.964 935.567H183.955L199.009 901.534H206.729L214.28 918.55L221.831 935.567H213.629L210.637 928.274ZM208.176 922.294L202.821 909.264L197.465 922.294H208.176ZM258.725 935.567H252.307L235.468 914.904V935.567H227.748V901.534H234.214L251.005 922.197V901.534H258.725V935.567ZM337.904 935.567H330.087V921.613H314.744V935.567H306.927V901.534H314.744V914.952H330.087V901.534H337.904V935.567ZM374.459 935.567V929.246H356.075V921.37H371.757V915.244H356.075V907.854H373.831V901.534H348.307V935.567H374.459ZM394.188 936.15C391.518 936.15 388.929 935.794 386.42 935.081C383.943 934.335 381.948 933.379 380.437 932.212L383.091 926.281C384.538 927.35 386.259 928.209 388.253 928.857C390.247 929.506 392.242 929.83 394.236 929.83C396.456 929.83 398.096 929.506 399.158 928.857C400.219 928.177 400.75 927.285 400.75 926.183C400.75 925.373 400.428 924.709 399.785 924.19C399.174 923.639 398.37 923.201 397.373 922.877C396.408 922.553 395.089 922.197 393.416 921.808C390.843 921.192 388.736 920.576 387.095 919.96C385.455 919.344 384.04 918.356 382.849 916.994C381.691 915.633 381.112 913.818 381.112 911.549C381.112 909.572 381.643 907.789 382.705 906.201C383.766 904.58 385.358 903.3 387.481 902.36C389.637 901.42 392.258 900.95 395.346 900.95C397.501 900.95 399.608 901.209 401.667 901.728C403.726 902.247 405.527 902.992 407.071 903.965L404.658 909.945C401.538 908.162 398.418 907.271 395.298 907.271C393.111 907.271 391.486 907.627 390.425 908.34C389.395 909.053 388.881 909.993 388.881 911.16C388.881 912.327 389.475 913.202 390.666 913.786C391.888 914.337 393.738 914.888 396.215 915.439C398.788 916.054 400.895 916.67 402.535 917.286C404.176 917.902 405.575 918.874 406.733 920.203C407.923 921.532 408.518 923.331 408.518 925.6C408.518 927.545 407.972 929.327 406.878 930.948C405.816 932.536 404.208 933.8 402.053 934.74C399.897 935.68 397.276 936.15 394.188 936.15ZM419.601 935.081C422.11 935.794 424.699 936.15 427.37 936.15C430.458 936.15 433.079 935.68 435.234 934.74C437.389 933.8 438.998 932.536 440.059 930.948C441.153 929.327 441.7 927.545 441.7 925.6C441.7 923.331 441.104 921.532 439.915 920.203C438.757 918.874 437.357 917.902 435.717 917.286C434.076 916.67 431.969 916.054 429.396 915.439C426.919 914.888 425.069 914.337 423.847 913.786C422.657 913.202 422.062 912.327 422.062 911.16C422.062 909.993 422.576 909.053 423.606 908.34C424.668 907.627 426.292 907.271 428.479 907.271C431.599 907.271 434.72 908.162 437.84 909.945L440.252 903.965C438.708 902.992 436.907 902.247 434.848 901.728C432.79 901.209 430.682 900.95 428.528 900.95C425.44 900.95 422.818 901.42 420.663 902.36C418.54 903.3 416.948 904.58 415.886 906.201C414.825 907.789 414.294 909.572 414.294 911.549C414.294 913.818 414.873 915.633 416.031 916.994C417.221 918.356 418.636 919.344 420.277 919.96C421.917 920.576 424.024 921.192 426.598 921.808C428.27 922.197 429.589 922.553 430.554 922.877C431.551 923.201 432.355 923.639 432.967 924.19C433.61 924.709 433.932 925.373 433.932 926.183C433.932 927.285 433.401 928.177 432.339 928.857C431.278 929.506 429.637 929.83 427.418 929.83C425.423 929.83 423.429 929.506 421.435 928.857C419.44 928.209 417.72 927.35 416.272 926.281L413.618 932.212C415.13 933.379 417.124 934.335 419.601 935.081Z" />',
                    '<path fill-rule="evenodd" clip-rule="evenodd"',
                    ' d="M64.5796 916.228L72.0899 908.718L81.6471 918.275L91.2824 908.64L98.8706 916.228C100.001 917.358 100.001 919.191 98.8706 920.322L91.295 927.897L81.6724 918.275L72.1026 927.845L64.5796 920.322C63.4491 919.191 63.4491 917.358 64.5796 916.228ZM77.8173 899.269C79.9755 897.11 83.4747 897.11 85.6329 899.269L100.731 914.367C102.89 916.525 102.89 920.025 100.731 922.183L85.6329 937.281C83.4747 939.439 79.9755 939.439 77.8173 937.281L62.7188 922.183C60.5605 920.025 60.5605 916.525 62.7188 914.367L77.8173 899.269Z" />',
                    _generateFooter(params),
                    "</g>",
                    "</svg>"
                )
            );
    }

    function _generateSVGDefs() private pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    "<defs>",
                    abi.encodePacked(
                        '<filter id="filter-1" x="-1217" y="-561" width="2295" height="2293" filterUnits="userSpaceOnUse"',
                        ' color-interpolation-filters="sRGB">',
                        '<feGaussianBlur stdDeviation="250" />',
                        "</filter>",
                        '<filter id="filter-2" x="-114" y="86" width="1830" height="1828" filterUnits="userSpaceOnUse"',
                        ' color-interpolation-filters="sRGB">',
                        '<feGaussianBlur stdDeviation="250" />',
                        "</filter>",
                        '<filter id="filter-3" x="-137" y="-1230" width="2392" height="2390" filterUnits="userSpaceOnUse"',
                        ' color-interpolation-filters="sRGB">',
                        '<feGaussianBlur stdDeviation="250" />',
                        "</filter>"
                    ),
                    '<linearGradient id="grad-symbol">',
                    '<stop offset="0.8" stop-color="white" stop-opacity="1" />',
                    '<stop offset=".95" stop-color="white" stop-opacity="0" />',
                    "</linearGradient>",
                    '<mask id="fade-symbol" maskContentUnits="userSpaceOnUse">',
                    '<rect width="1000" height="1000" fill="url(#grad-symbol)" />',
                    "</mask>",
                    "</defs>"
                )
            );
    }

    function _generateChessboard(SVGParams memory params) private pure returns (string memory) {
        uint256 scale = 50;
        if (params.amount >= 100e18) {
            scale = 10;
        } else if (params.amount > 1e18) {
            scale = ((params.amount - 1e18) * 40) / 99e18 + 10;
        }
        return
            string(
                abi.encodePacked(
                    '<g style="mix-blend-mode:overlay" transform="scale(',
                    scale.toString(),
                    ')" transform-origin="500 75.7359">',
                    '<g transform="rotate(45 500 500)" fill="white">',
                    _generateGrids(params),
                    "</g>",
                    "</g>"
                )
            );
    }

    function _generateClaimable(SVGParams memory params) private pure returns (string memory) {
        if (!params.claimable) {
            return "";
        }
        return
            string(
                abi.encodePacked(
                    '<text x="60" y="276.685" font-size="30" font-weight="bold">Claimable ETH</text>',
                    '<text x="60" y="378.95" mask="url(#fade-symbol)" font-size="100" font-weight="bold">3.141592653589793238</text>'
                )
            );
    }

    function _generateGrids(SVGParams memory params) private pure returns (string memory svg) {
        if (!params.animated) {
            for (uint256 i = 0; i < 8; i++) {
                for (uint256 j = 0; j < 4; j++) {
                    svg = string(
                        abi.encodePacked(
                            svg,
                            _generateStaticGrids(i, j, params.randomStrings[i * 4 + j])
                        )
                    );
                }
            }
            return svg;
        }

        for (uint256 i = 0; i < 8; i++) {
            for (uint256 j = 0; j < 4; j++) {
                svg = string(
                    abi.encodePacked(
                        svg,
                        _generateAnimatedGrids(i, j, params.randomStrings[i * 4 + j])
                    )
                );
            }
        }
    }

    function _generateStaticGrids(
        uint256 i,
        uint256 j,
        string memory opacity
    ) private pure returns (string memory) {
        string memory x = _convertToDecimal(i % 2 == 0 ? 2000 + j * 150 : 2075 + j * 150);
        string memory y = _convertToDecimal(2000 + i * 75);
        return
            string(
                abi.encodePacked(
                    '<rect opacity="',
                    opacity,
                    '" x="',
                    x,
                    '" y="',
                    y,
                    '" width="7.5" height="7.5" />'
                )
            );
    }

    function _generateAnimatedGrids(
        uint256 i,
        uint256 j,
        string memory begin
    ) private pure returns (string memory) {
        string memory x = _convertToDecimal(i % 2 == 0 ? 2000 + j * 150 : 2075 + j * 150);
        string memory y = _convertToDecimal(2000 + i * 75);
        return
            string(
                abi.encodePacked(
                    '<rect x="',
                    x,
                    '" y="',
                    y,
                    '" width="7.5" height="7.5">',
                    '<animate attributeName="opacity" values="0.1;1;0.1" begin="',
                    begin,
                    '" dur="9s" repeatCount="indefinite" />',
                    "</rect>"
                )
            );
    }

    function _generateFooter(SVGParams memory params) private pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    '<text font-size="16" text-anchor="end" x="940" y="938.452">#',
                    params.tokenId.toString(),
                    "</text>"
                )
            );
    }

    function _convertToDecimal(uint256 value) public pure returns (string memory) {
        if (value % 10 == 0) {
            return (value / 10).toString();
        }
        return string(abi.encodePacked((value / 10).toString(), ".5"));
    }

    function _escapeQuotes(string memory symbol) private pure returns (string memory) {
        bytes memory symbolBytes = bytes(symbol);
        uint8 quotesCount = 0;
        for (uint8 i = 0; i < symbolBytes.length; i++) {
            if (symbolBytes[i] == '"') {
                quotesCount++;
            }
        }
        if (quotesCount > 0) {
            bytes memory escapedBytes = new bytes(symbolBytes.length + (quotesCount));
            uint256 index;
            for (uint8 i = 0; i < symbolBytes.length; i++) {
                if (symbolBytes[i] == '"') {
                    escapedBytes[index++] = "\\";
                }
                escapedBytes[index++] = symbolBytes[i];
            }
            return string(escapedBytes);
        }
        return symbol;
    }

    function _addressToString(address addr) private pure returns (string memory) {
        return (uint256(addr)).toHexString(20);
    }
}
