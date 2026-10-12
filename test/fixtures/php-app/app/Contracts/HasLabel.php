<?php

declare(strict_types=1);

namespace App\Contracts;

interface HasLabel
{
    public function label(): string;
}
