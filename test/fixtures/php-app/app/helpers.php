<?php

if (! function_exists('money')) {
    function money(int $cents): string
    {
        return \App\Support\format_money($cents);
    }
}
