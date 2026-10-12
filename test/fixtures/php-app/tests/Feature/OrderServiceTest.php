<?php

namespace Tests\Feature;

use App\Enums\OrderStatus;
use App\Services\OrderService;
use Tests\TestCase;

final class OrderServiceTest extends TestCase
{
    public function test_default_status(): void
    {
        $this->assertSame(OrderStatus::Pending, OrderStatus::DEFAULT);
        $this->assertTrue(class_exists(OrderService::class));
    }
}
